import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from './constants.js';
import { ModuleSettings } from './settings.js';

class MockApplicationV2 {}

describe('ModuleSettings categorized configuration', () => {
  const registrations = new Map<string, any>();
  const menus = new Map<string, any>();
  const values = new Map<string, unknown>();
  const worldStorage = { getSetting: vi.fn() };
  const browserStorage = new Map<string, string>();
  const settingWrites: Array<{ key: string; scope: string; value: unknown }> = [];
  const bridge = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    refreshCapturePolicy: vi.fn(),
    refreshStandbyConfiguration: vi.fn(),
    getStatus: vi.fn(() => bridgeStatus),
  };
  let bridgeStatus: any;
  let failSetKey: string | null;
  let failBrowserWrite: boolean;

  beforeEach(() => {
    registrations.clear();
    menus.clear();
    values.clear();
    settingWrites.length = 0;
    vi.clearAllMocks();
    failSetKey = null;
    failBrowserWrite = false;
    bridgeStatus = { connected: false, connectionInfo: null };
    worldStorage.getSetting.mockReturnValue(undefined);
    browserStorage.clear();

    const gameSettings = {
      settings: registrations,
      menus,
      storage: new Map([['world', worldStorage]]),
      register: (moduleId: string, key: string, options: any) => {
        const id = `${moduleId}.${key}`;
        registrations.set(id, options);
        values.set(id, options.default);
      },
      registerMenu: (moduleId: string, key: string, options: any) => {
        menus.set(`${moduleId}.${key}`, options);
      },
      get: (moduleId: string, key: string) => values.get(`${moduleId}.${key}`),
      set: async (
        moduleId: string,
        key: string,
        value: unknown,
        options?: Record<string, unknown>
      ) => {
        if (key === failSetKey) {
          failSetKey = null;
          throw new Error(`simulated ${key} persistence failure`);
        }
        const id = `${moduleId}.${key}`;
        settingWrites.push({ key, scope: registrations.get(id)?.scope, value });
        values.set(id, value);
        registrations.get(id)?.onChange?.(value, options, 'gm-a');
        return value;
      },
    };

    (globalThis as any).foundry = {
      applications: {
        api: {
          ApplicationV2: MockApplicationV2,
          HandlebarsApplicationMixin: (Base: typeof MockApplicationV2) => class extends Base {},
        },
      },
    };
    (globalThis as any).game = {
      settings: gameSettings,
      user: { id: 'gm-a', isGM: true },
      world: { id: 'world-a' },
    };
    (globalThis as any).localStorage = {
      getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failBrowserWrite) throw new Error('simulated browser storage failure');
        browserStorage.set(key, value);
      },
      removeItem: (key: string) => browserStorage.delete(key),
    };
    (globalThis as any).ui = { notifications: { info: vi.fn() } };
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'http:' };
    (globalThis as any).foundryMCPBridge = bridge;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).foundry;
    delete (globalThis as any).game;
    delete (globalThis as any).ui;
    delete (globalThis as any).foundryMCPBridge;
    delete (globalThis as any).window;
    delete (globalThis as any).location;
    delete (globalThis as any).localStorage;
  });

  it('hides individual controls and registers four category launchers', () => {
    const settings = new ModuleSettings();
    settings.registerSettings();

    const configurable = [...registrations.values()].filter(setting => setting.config === true);
    expect(configurable).toEqual([]);
    expect([...menus.keys()]).toEqual([
      `${MODULE_ID}.connectionSettings`,
      `${MODULE_ID}.permissionsSettings`,
      `${MODULE_ID}.consoleSettings`,
      `${MODULE_ID}.advancedSettings`,
    ]);
  });

  it('coerces a connection form and restarts exactly once', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();

    await settings.applyCategorySettings('connection', {
      enabled: true,
      connectionType: 'websocket',
      serverHost: '127.0.0.1',
      serverPort: '31417',
      authToken: 'secret',
      autoReconnectEnabled: true,
      heartbeatInterval: '45',
      enableNotifications: false,
    });

    expect(values.get(`${MODULE_ID}.serverPort`)).toBe(31417);
    expect(values.get(`${MODULE_ID}.heartbeatInterval`)).toBe(45);
    expect(values.get(`${MODULE_ID}.enableNotifications`)).toBe(false);
    expect(settings.getSetting('authToken')).toBe('secret');
    expect(bridge.restart).toHaveBeenCalledTimes(1);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it('applies console changes with one policy refresh', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();

    await settings.applyCategorySettings('console', {
      enableConsoleCapture: true,
      suspendConsoleCaptureWhileIdle: false,
      consoleCaptureIdleTimeout: '180',
      consoleCaptureMaxEntries: '2000',
      consoleCaptureMaxEntryBytes: '16384',
      consoleCaptureIncludeDebug: false,
      consoleCaptureIncludeTrace: false,
    });

    expect(bridge.refreshCapturePolicy).toHaveBeenCalledTimes(1);
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('rejects invalid values before changing any setting', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const priorPort = values.get(`${MODULE_ID}.serverPort`);

    await expect(
      settings.applyCategorySettings('connection', { serverPort: '70000' })
    ).rejects.toThrow('serverPort must be a number between 1024 and 65535');

    expect(values.get(`${MODULE_ID}.serverPort`)).toBe(priorPort);
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('rejects fractional ports before restarting the connection', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();

    await expect(
      settings.applyCategorySettings('connection', { serverPort: '31414.5' })
    ).rejects.toThrow('serverPort must be a number between 1024 and 65535');

    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('reserves the next port for Auto and WebRTC but allows WebSocket on 65535', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const submission = (connectionType: string) => ({
      enabled: true,
      connectionType,
      serverHost: '127.0.0.1',
      serverPort: '65535',
      authToken: '',
      autoReconnectEnabled: true,
      heartbeatInterval: '30',
      enableNotifications: true,
    });

    await expect(settings.applyCategorySettings('connection', submission('auto'))).rejects.toThrow(
      'Server port must be between 1024 and 65534 for Auto or WebRTC'
    );
    await expect(
      settings.applyCategorySettings('connection', submission('webrtc'))
    ).rejects.toThrow('Server port must be between 1024 and 65534 for Auto or WebRTC');
    expect(bridge.restart).not.toHaveBeenCalled();

    await expect(
      settings.applyCategorySettings('connection', submission('websocket'))
    ).resolves.toBeUndefined();
    expect(values.get(`${MODULE_ID}.serverPort`)).toBe(65535);
    expect(bridge.restart).toHaveBeenCalledTimes(1);
  });

  it('rejects HTTPS loopback WebSocket without rejecting HTTPS WSS proxies', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    (globalThis as any).location.protocol = 'https:';
    const submission = (serverHost: string) => ({
      enabled: true,
      connectionType: 'websocket',
      serverHost,
      serverPort: '31415',
      authToken: '',
      autoReconnectEnabled: true,
      heartbeatInterval: '30',
      enableNotifications: true,
    });

    await expect(
      settings.applyCategorySettings('connection', submission('localhost'))
    ).rejects.toThrow('select Auto or WebRTC');
    expect(bridge.restart).not.toHaveBeenCalled();

    await expect(
      settings.applyCategorySettings('connection', submission('bridge.example.test'))
    ).resolves.toBeUndefined();
    expect(bridge.restart).toHaveBeenCalledTimes(1);
  });

  it('reports persisted transport-specific connection validation errors', () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    values.set(`${MODULE_ID}.serverPort`, 65535);

    expect(settings.validateSettings().errors).toContain(
      'Server port must be between 1024 and 65534 for Auto or WebRTC because signaling uses the next port'
    );

    values.set(`${MODULE_ID}.connectionType`, 'websocket');
    expect(settings.validateSettings().errors).not.toContainEqual(expect.stringContaining('65534'));
    (globalThis as any).location.protocol = 'https:';
    values.set(`${MODULE_ID}.serverHost`, '::1');
    expect(settings.validateSettings().errors).toContainEqual(
      expect.stringContaining('select Auto or WebRTC')
    );
  });

  it('rolls back earlier writes when a later setting cannot be persisted', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const priorType = values.get(`${MODULE_ID}.connectionType`);
    const priorHost = values.get(`${MODULE_ID}.serverHost`);
    failSetKey = 'serverPort';

    await expect(
      settings.applyCategorySettings('connection', {
        enabled: true,
        connectionType: 'websocket',
        serverHost: '127.0.0.1',
        serverPort: '31417',
        authToken: '',
        autoReconnectEnabled: true,
        heartbeatInterval: '30',
        enableNotifications: true,
      })
    ).rejects.toThrow('simulated serverPort persistence failure');

    expect(values.get(`${MODULE_ID}.connectionType`)).toBe(priorType);
    expect(values.get(`${MODULE_ID}.serverHost`)).toBe(priorHost);
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('rolls back world fields when browser-local token persistence fails', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const priorType = values.get(`${MODULE_ID}.connectionType`);
    const priorHost = values.get(`${MODULE_ID}.serverHost`);
    const priorPort = values.get(`${MODULE_ID}.serverPort`);
    failBrowserWrite = true;

    await expect(
      settings.applyCategorySettings('connection', {
        enabled: true,
        connectionType: 'websocket',
        serverHost: '127.0.0.1',
        serverPort: '31417',
        authToken: 'cannot-save',
        autoReconnectEnabled: true,
        heartbeatInterval: '30',
        enableNotifications: true,
      })
    ).rejects.toThrow('simulated browser storage failure');

    expect(values.get(`${MODULE_ID}.connectionType`)).toBe(priorType);
    expect(values.get(`${MODULE_ID}.serverHost`)).toBe(priorHost);
    expect(values.get(`${MODULE_ID}.serverPort`)).toBe(priorPort);
    expect(settings.getSetting('authToken')).toBe('');
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('serializes submissions from distinct category windows', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const originalSetSetting = settings.setSetting.bind(settings);
    let releaseBlockedWrite!: () => void;
    let signalBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => (releaseBlockedWrite = resolve));
    const writeStarted = new Promise<void>(resolve => (signalBlockedWrite = resolve));
    let shouldBlock = true;
    vi.spyOn(settings, 'setSetting').mockImplementation(async (key, value, options) => {
      if (key === 'serverHost' && shouldBlock) {
        shouldBlock = false;
        signalBlockedWrite();
        await blockedWrite;
      }
      return originalSetSetting(key, value, options);
    });

    const connectionSave = settings.applyCategorySettings('connection', {
      enabled: true,
      connectionType: 'websocket',
      serverHost: '127.0.0.1',
      serverPort: '31417',
      authToken: '',
      autoReconnectEnabled: true,
      heartbeatInterval: '30',
      enableNotifications: true,
    });
    await writeStarted;
    const consoleSave = settings.applyCategorySettings('console', {
      enableConsoleCapture: true,
      suspendConsoleCaptureWhileIdle: false,
      consoleCaptureIdleTimeout: '180',
      consoleCaptureMaxEntries: '2000',
      consoleCaptureMaxEntryBytes: '16384',
      consoleCaptureIncludeDebug: false,
      consoleCaptureIncludeTrace: false,
    });

    await Promise.resolve();
    expect(values.get(`${MODULE_ID}.suspendConsoleCaptureWhileIdle`)).toBe(true);
    expect(bridge.refreshCapturePolicy).not.toHaveBeenCalled();

    releaseBlockedWrite();
    await Promise.all([connectionSave, consoleSave]);
    expect(bridge.restart).toHaveBeenCalledTimes(1);
    expect(bridge.refreshCapturePolicy).toHaveBeenCalledTimes(1);
  });

  it('flushes a prior broadcast after a later category save rolls back', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();
    bridgeStatus = { connected: true, connectionInfo: { standbyBecauseOwnerActive: false } };
    values.set(`${MODULE_ID}.serverPort`, 31416);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31416, {}, 'gm-b');
    failSetKey = 'serverPort';

    await expect(
      settings.applyCategorySettings('connection', {
        enabled: true,
        connectionType: 'websocket',
        serverHost: '127.0.0.1',
        serverPort: '31417',
        authToken: '',
        autoReconnectEnabled: true,
        heartbeatInterval: '30',
        enableNotifications: true,
      })
    ).rejects.toThrow('simulated serverPort persistence failure');

    expect(bridge.restart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.restart).toHaveBeenCalledTimes(1);
  });

  it('retains a same-GM second-tab broadcast received during a failed category save', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const originalSetSetting = settings.setSetting.bind(settings);
    let releaseBlockedWrite!: () => void;
    let signalBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => (releaseBlockedWrite = resolve));
    const writeStarted = new Promise<void>(resolve => (signalBlockedWrite = resolve));
    let shouldBlock = true;
    vi.spyOn(settings, 'setSetting').mockImplementation(async (key, value, options) => {
      if (key === 'serverHost' && shouldBlock) {
        shouldBlock = false;
        signalBlockedWrite();
        await blockedWrite;
      }
      return originalSetSetting(key, value, options);
    });
    failSetKey = 'serverPort';

    const save = settings.applyCategorySettings('connection', {
      enabled: true,
      connectionType: 'websocket',
      serverHost: '127.0.0.1',
      serverPort: '31417',
      authToken: '',
      autoReconnectEnabled: true,
      heartbeatInterval: '30',
      enableNotifications: true,
    });
    await writeStarted;
    values.set(`${MODULE_ID}.enableConsoleCapture`, false);
    registrations
      .get(`${MODULE_ID}.enableConsoleCapture`)
      .onChange(false, { foundryMcpSettingsTransaction: 'other-tab:1' }, 'gm-a');
    releaseBlockedWrite();

    await expect(save).rejects.toThrow('simulated serverPort persistence failure');
    expect(bridge.refreshCapturePolicy).toHaveBeenCalledTimes(1);
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('keeps the auth token out of status settings', () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    values.set(`${MODULE_ID}.authToken`, 'do-not-expose');

    expect(settings.getAllSettings()).not.toHaveProperty('authToken');
    expect(settings.getAllSettings()).toHaveProperty('enableEventPush', true);
  });

  it('stores the auth token in this client rather than the world', () => {
    const settings = new ModuleSettings();
    settings.registerSettings();

    expect(registrations.get(`${MODULE_ID}.authToken`)).toMatchObject({
      scope: 'client',
      config: false,
      default: '',
    });
  });

  it('keeps browser-local auth tokens distinct for worlds on the same origin', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();

    await settings.setSetting('authToken', 'world-a-secret');
    (globalThis as any).game.world.id = 'world-b';
    expect(settings.getSetting('authToken')).toBe('');
    await settings.setSetting('authToken', 'world-b-secret');

    (globalThis as any).game.world.id = 'world-a';
    expect(settings.getSetting('authToken')).toBe('world-a-secret');
    (globalThis as any).game.world.id = 'world-b';
    expect(settings.getSetting('authToken')).toBe('world-b-secret');
    expect(values.get(`${MODULE_ID}.authToken`)).toBe('');
  });

  it('coalesces external connection broadcasts into one GM-side restart', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();

    values.set(`${MODULE_ID}.serverHost`, '127.0.0.1');
    registrations.get(`${MODULE_ID}.serverHost`).onChange('127.0.0.1');
    await vi.advanceTimersByTimeAsync(150);
    values.set(`${MODULE_ID}.serverPort`, 31417);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31417);
    await vi.advanceTimersByTimeAsync(150);
    values.set(`${MODULE_ID}.connectionType`, 'websocket');
    registrations.get(`${MODULE_ID}.connectionType`).onChange('websocket');

    await vi.advanceTimersByTimeAsync(249);
    expect(bridge.restart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.restart).toHaveBeenCalledTimes(1);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it('lets the connected owner apply another GM connection broadcast', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();
    bridgeStatus = { connected: true, connectionInfo: { standbyBecauseOwnerActive: false } };

    values.set(`${MODULE_ID}.serverPort`, 31417);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31417, {}, 'gm-b');
    await vi.advanceTimersByTimeAsync(250);

    expect(bridge.restart).toHaveBeenCalledTimes(1);
    expect(bridge.refreshStandbyConfiguration).not.toHaveBeenCalled();
  });

  it('keeps a disconnected non-owner passive for another GM broadcast', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();
    bridgeStatus = { connected: false, connectionInfo: null };

    values.set(`${MODULE_ID}.serverPort`, 31417);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31417, {}, 'gm-b');
    await vi.advanceTimersByTimeAsync(500);

    expect(bridge.restart).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.refreshStandbyConfiguration).not.toHaveBeenCalled();
  });

  it('refreshes standby retry configuration without restarting for another GM broadcast', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();
    bridgeStatus = { connected: false, connectionInfo: { standbyBecauseOwnerActive: true } };

    values.set(`${MODULE_ID}.serverPort`, 31417);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31417, {}, 'gm-b');
    await vi.advanceTimersByTimeAsync(500);

    expect(bridge.refreshStandbyConfiguration).toHaveBeenCalledTimes(1);
    expect(bridge.restart).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it('stops every GM retry owner when another GM disables the bridge', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();
    bridgeStatus = { connected: false, connectionInfo: { standbyBecauseOwnerActive: true } };
    values.set(`${MODULE_ID}.enabled`, false);

    registrations.get(`${MODULE_ID}.enabled`).onChange(false, {}, 'gm-b');
    await vi.advanceTimersByTimeAsync(250);

    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('honors a local category save from a standby GM exactly once', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    bridgeStatus = { connected: false, connectionInfo: { standbyBecauseOwnerActive: true } };

    await settings.applyCategorySettings('connection', {
      enabled: true,
      connectionType: 'websocket',
      serverHost: '127.0.0.1',
      serverPort: '31417',
      authToken: 'local-secret',
      autoReconnectEnabled: true,
      heartbeatInterval: '30',
      enableNotifications: true,
    });

    expect(bridge.restart).toHaveBeenCalledTimes(1);
    expect(bridge.refreshStandbyConfiguration).not.toHaveBeenCalled();
    expect(settings.getSetting('authToken')).toBe('local-secret');
  });

  it('coalesces enabled and connection broadcasts into one final transition', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();

    values.set(`${MODULE_ID}.enabled`, false);
    registrations.get(`${MODULE_ID}.enabled`).onChange(false);
    values.set(`${MODULE_ID}.serverPort`, 31417);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31417);

    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it('ignores bridge side effects from setting broadcasts on player clients', async () => {
    vi.useFakeTimers();
    const settings = new ModuleSettings();
    settings.registerSettings();
    (globalThis as any).game.user.isGM = false;

    registrations.get(`${MODULE_ID}.enabled`).onChange(false);
    registrations.get(`${MODULE_ID}.serverPort`).onChange(31417);
    registrations.get(`${MODULE_ID}.enableConsoleCapture`).onChange(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.restart).not.toHaveBeenCalled();
    expect(bridge.refreshCapturePolicy).not.toHaveBeenCalled();
  });

  it('migrates the legacy world token client-side and deletes obsolete world settings once', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    const deletedKeys: string[] = [];
    const legacyDocuments = new Map<string, any>();
    for (const key of [
      'enableEnhancedCreatureIndex',
      'autoRebuildIndex',
      'mapGenAutoStart',
      'mapGenQuality',
    ]) {
      const fullKey = `${MODULE_ID}.${key}`;
      legacyDocuments.set(fullKey, {
        delete: vi.fn(async () => deletedKeys.push(fullKey)),
      });
    }
    const legacyAuthKey = `${MODULE_ID}.authToken`;
    legacyDocuments.set(legacyAuthKey, {
      value: 'legacy-secret',
      delete: vi.fn(async () => deletedKeys.push(legacyAuthKey)),
    });
    worldStorage.getSetting.mockImplementation((key: string) => legacyDocuments.get(key));

    await expect(settings.migrateRemovedFeatureState()).resolves.toEqual([
      'enableEnhancedCreatureIndex',
      'autoRebuildIndex',
      'mapGenAutoStart',
      'mapGenQuality',
    ]);

    expect(deletedKeys).toEqual([
      `${MODULE_ID}.enableEnhancedCreatureIndex`,
      `${MODULE_ID}.autoRebuildIndex`,
      `${MODULE_ID}.mapGenAutoStart`,
      `${MODULE_ID}.mapGenQuality`,
      `${MODULE_ID}.authToken`,
    ]);
    expect(settings.getSetting('authToken')).toBe('legacy-secret');
    expect(values.get(`${MODULE_ID}.authToken`)).toBe('');
    expect(settingWrites.filter(write => write.key === 'authToken')).toEqual([]);
    expect(values.get(`${MODULE_ID}.migrationVersion`)).toBe(2);
    expect(bridge.restart).not.toHaveBeenCalled();

    await expect(settings.migrateRemovedFeatureState()).resolves.toEqual([]);
    expect(deletedKeys).toHaveLength(5);
  });

  it('preserves an existing client token while cleaning a version-one world token', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    values.set(`${MODULE_ID}.migrationVersion`, 1);
    browserStorage.set(`${MODULE_ID}.authToken.world-a`, 'browser-secret');
    const deleteLegacyToken = vi.fn(async () => undefined);
    worldStorage.getSetting.mockImplementation((key: string) =>
      key === `${MODULE_ID}.authToken`
        ? { value: 'obsolete-world-secret', delete: deleteLegacyToken }
        : undefined
    );

    await expect(settings.migrateRemovedFeatureState()).resolves.toEqual([]);

    expect(settings.getSetting('authToken')).toBe('browser-secret');
    expect(values.get(`${MODULE_ID}.authToken`)).toBe('');
    expect(deleteLegacyToken).toHaveBeenCalledTimes(1);
    expect(settingWrites.filter(write => write.key === 'authToken')).toEqual([]);
    expect(values.get(`${MODULE_ID}.migrationVersion`)).toBe(2);
  });

  it('does not inspect or migrate the legacy secret from a player client', async () => {
    const settings = new ModuleSettings();
    settings.registerSettings();
    (globalThis as any).game.user.isGM = false;

    await expect(settings.migrateRemovedFeatureState()).resolves.toEqual([]);

    expect(worldStorage.getSetting).not.toHaveBeenCalled();
    expect(values.get(`${MODULE_ID}.migrationVersion`)).toBe(0);
    expect(settingWrites).toEqual([]);
  });
});
