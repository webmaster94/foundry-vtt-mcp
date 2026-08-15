import { MODULE_ID, DEFAULT_CONFIG } from './constants.js';
import type { BridgeConfig } from './socket-bridge.js';
import {
  registerSettingsMenus,
  type SettingsCategory,
  type SettingsFormHost,
} from './settings-forms.js';

const CATEGORY_SETTING_KEYS: Record<SettingsCategory, readonly string[]> = {
  connection: [
    'enabled',
    'connectionType',
    'serverHost',
    'serverPort',
    'authToken',
    'autoReconnectEnabled',
    'heartbeatInterval',
    'enableNotifications',
  ],
  permissions: [
    'allowWriteOperations',
    'maxActorsPerRequest',
    'readOnlyRiskyDocuments',
    'auditRetention',
    'enableEventPush',
  ],
  console: [
    'enableConsoleCapture',
    'suspendConsoleCaptureWhileIdle',
    'consoleCaptureIdleTimeout',
    'consoleCaptureMaxEntries',
    'consoleCaptureMaxEntryBytes',
    'consoleCaptureIncludeDebug',
    'consoleCaptureIncludeTrace',
  ],
  advanced: [
    'allowBrowserCodeExecution',
    'scriptTimeoutMs',
    'scriptMaxLength',
    'scriptResultMaxBytes',
    'documentResultMaxBytes',
  ],
};

const BOOLEAN_SETTING_KEYS = new Set([
  'enabled',
  'autoReconnectEnabled',
  'enableNotifications',
  'allowWriteOperations',
  'readOnlyRiskyDocuments',
  'enableEventPush',
  'enableConsoleCapture',
  'suspendConsoleCaptureWhileIdle',
  'consoleCaptureIncludeDebug',
  'consoleCaptureIncludeTrace',
  'allowBrowserCodeExecution',
]);

const NUMBER_SETTING_BOUNDS: Record<string, readonly [number, number]> = {
  serverPort: [1024, 65535],
  heartbeatInterval: [10, 120],
  maxActorsPerRequest: [1, 50],
  auditRetention: [10, 5000],
  consoleCaptureIdleTimeout: [30, 900],
  consoleCaptureMaxEntries: [100, 10000],
  consoleCaptureMaxEntryBytes: [512, 65536],
  scriptTimeoutMs: [100, 30000],
  scriptMaxLength: [1000, 100000],
  scriptResultMaxBytes: [1000, 2000000],
  documentResultMaxBytes: [1000, 2000000],
};

const REMOVED_WORLD_SETTING_KEYS = [
  'enableEnhancedCreatureIndex',
  'autoRebuildIndex',
  'mapGenAutoStart',
  'mapGenQuality',
] as const;
const LEGACY_WORLD_AUTH_TOKEN_KEY = 'authToken';
const CURRENT_MIGRATION_VERSION = 2;
const SETTING_EFFECT_DEBOUNCE_MS = 250;
const MAX_WEBRTC_BASE_PORT = 65534;
const CATEGORY_TRANSACTION_OPTION = 'foundryMcpSettingsTransaction';

export class ModuleSettings implements SettingsFormHost {
  private moduleId: string = MODULE_ID;
  private applyingCategorySettings = false;
  private pendingEnabledChange: boolean | null = null;
  private pendingConnectionChange = false;
  private pendingConsoleCaptureChange = false;
  private externalEnabledDuringCategory: boolean | null = null;
  private externalConnectionDuringCategory = false;
  private externalConsoleDuringCategory = false;
  private settingEffectTimer: ReturnType<typeof setTimeout> | null = null;
  private settingEffectRun: Promise<void> = Promise.resolve();
  private categorySaveTail: Promise<void> = Promise.resolve();
  private readonly categoryTransactionInstanceId =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  private activeCategoryTransactionId: string | null = null;
  private categoryTransactionSequence = 0;
  private suppressSettingEffects = false;

  /**
   * Register all module settings with Foundry
   */
  registerSettings(): void {
    // ============================================================================
    // SECTION 1: BASIC SETTINGS
    // ============================================================================

    game.settings.register(this.moduleId, 'enabled', {
      name: 'Enable MCP Bridge',
      hint: 'Master switch to enable/disable the MCP bridge connection',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
      onChange: this.onEnabledChange.bind(this),
    });

    game.settings.register(this.moduleId, 'connectionType', {
      name: 'Connection Type',
      hint: 'Auto: Smart selection (HTTPS→WebRTC, HTTP→WebSocket). WebRTC: encrypted browser-to-local bridge transport. WebSocket: local HTTP worlds or a separately configured TLS/WSS proxy; HTTPS loopback requires Auto or WebRTC.',
      scope: 'world',
      config: false,
      type: String,
      choices: {
        auto: 'Auto (Recommended)',
        webrtc: 'WebRTC (Internet)',
        websocket: 'WebSocket (HTTP / WSS Proxy)',
      },
      default: 'auto',
      onChange: this.onConnectionChange.bind(this),
    });

    game.settings.register(this.moduleId, 'serverHost', {
      name: 'Bridge Server Host',
      hint: 'Host reached by this GM browser for WebSocket or WebRTC signaling (usually localhost; use a private IP or .local name only when the server runs on another machine)',
      scope: 'world',
      config: false,
      type: String,
      default: DEFAULT_CONFIG.MCP_HOST,
      onChange: this.onConnectionChange.bind(this),
    });

    game.settings.register(this.moduleId, 'serverPort', {
      name: 'Server Port',
      hint: 'Port number for MCP server communication',
      scope: 'world',
      config: false,
      type: Number,
      default: DEFAULT_CONFIG.MCP_PORT,
      onChange: this.onConnectionChange.bind(this),
    });

    // ============================================================================
    // SECTION 2: WRITE PERMISSIONS
    // ============================================================================

    game.settings.register(this.moduleId, 'allowWriteOperations', {
      name: 'Allow Write Operations',
      hint: 'Let AI model create actors, NPCs, and modify world content. Reading is always allowed.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
    });

    // ============================================================================
    // SECTION 3: SAFETY CONTROLS - Limits on AI model's Actions
    // ============================================================================

    game.settings.register(this.moduleId, 'maxActorsPerRequest', {
      name: 'Max Actors Per Request',
      hint: 'Maximum number of actors AI model can create in a single request',
      scope: 'world',
      config: false,
      type: Number,
      default: 10,
      range: {
        min: 1,
        max: 50,
        step: 1,
      },
    });

    game.settings.register(this.moduleId, 'enableConsoleCapture', {
      name: 'Capture Browser Console',
      hint: 'Allow MCP clients to capture recent GM browser console output. With idle suspension enabled, capture wakes automatically for MCP queries and otherwise has no console-hook overhead.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'suspendConsoleCaptureWhileIdle', {
      name: 'Pause Console Capture While Idle',
      hint: 'Recommended. Keep the lightweight bridge connection ready, but remove console hooks until an MCP query arrives. Capture pauses again after the idle timeout.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'consoleCaptureIdleTimeout', {
      name: 'Console Capture Idle Timeout',
      hint: 'Seconds to keep browser console capture active after the last MCP query finishes.',
      scope: 'world',
      config: false,
      type: Number,
      default: 120,
      range: {
        min: 30,
        max: 900,
        step: 30,
      },
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'consoleCaptureMaxEntries', {
      name: 'Console Capture Max Entries',
      hint: 'Maximum number of recent browser console entries kept in memory. Refreshing the browser tab clears this buffer.',
      scope: 'world',
      config: false,
      type: Number,
      default: 1000,
      range: {
        min: 100,
        max: 10000,
        step: 100,
      },
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'consoleCaptureMaxEntryBytes', {
      name: 'Console Capture Max Entry Size',
      hint: 'Maximum serialized size for a single captured console entry.',
      scope: 'world',
      config: false,
      type: Number,
      default: 8192,
      range: {
        min: 512,
        max: 65536,
        step: 512,
      },
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'consoleCaptureIncludeDebug', {
      name: 'Capture Debug Console Messages',
      hint: 'Include console.debug output in browser console capture.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'consoleCaptureIncludeTrace', {
      name: 'Capture Trace Console Messages',
      hint: 'Include console.trace output in browser console capture.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
      onChange: this.onConsoleCaptureChange.bind(this),
    });

    game.settings.register(this.moduleId, 'allowBrowserCodeExecution', {
      name: 'Allow Browser Code Execution',
      hint: 'Allow MCP clients to execute JavaScript immediately in this GM browser. This is powerful and separate from normal write-operation permissions.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
    });

    game.settings.register(this.moduleId, 'scriptTimeoutMs', {
      name: 'Script Timeout',
      hint: 'Maximum time to wait for async browser script execution. CPU-blocking loops can still freeze the browser tab.',
      scope: 'world',
      config: false,
      type: Number,
      default: 5000,
      range: {
        min: 100,
        max: 30000,
        step: 100,
      },
    });

    game.settings.register(this.moduleId, 'scriptMaxLength', {
      name: 'Script Max Length',
      hint: 'Maximum number of characters in a browser script execution request.',
      scope: 'world',
      config: false,
      type: Number,
      default: 20000,
      range: {
        min: 1000,
        max: 100000,
        step: 1000,
      },
    });

    game.settings.register(this.moduleId, 'scriptResultMaxBytes', {
      name: 'Script Result Max Bytes',
      hint: 'Maximum serialized result size returned by browser script execution.',
      scope: 'world',
      config: false,
      type: Number,
      default: 256000,
      range: {
        min: 1000,
        max: 2000000,
        step: 1000,
      },
    });

    game.settings.register(this.moduleId, 'documentResultMaxBytes', {
      name: 'Document Result Max Bytes',
      hint: 'Maximum serialized result size returned by document and query explorer tools.',
      scope: 'world',
      config: false,
      type: Number,
      default: 256000,
      range: {
        min: 1000,
        max: 2000000,
        step: 1000,
      },
    });

    game.settings.register(this.moduleId, 'authToken', {
      name: 'Bridge Auth Token',
      hint: 'Optional shared secret stored only in this browser. It must match the MCP server profile authToken. Required for safe remote (0.0.0.0) setups.',
      scope: 'client',
      config: false,
      type: String,
      default: '',
    });

    game.settings.register(this.moduleId, 'enableEventPush', {
      name: 'Push Game Events to MCP',
      hint: 'Send combat turns, chat messages, and dice results to the MCP server so AI agents can react to them (wait-for-event).',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
    });

    // Hidden storage for the MCP audit log (world scope; game.world has no
    // flag API on the client, so a setting is the reliable world-level store)
    game.settings.register(this.moduleId, 'auditLogs', {
      scope: 'world',
      config: false,
      type: Array,
      default: [],
    });

    game.settings.register(this.moduleId, 'auditLogSequence', {
      scope: 'world',
      config: false,
      type: Number,
      default: 0,
    });

    game.settings.register(this.moduleId, 'auditRetention', {
      name: 'Audit Log Retention',
      hint: 'Number of MCP audit entries retained in world settings.',
      scope: 'world',
      config: false,
      type: Number,
      default: 500,
      range: {
        min: 10,
        max: 5000,
        step: 10,
      },
    });

    game.settings.register(this.moduleId, 'readOnlyRiskyDocuments', {
      name: 'Read Only Risky Documents',
      hint: 'Keep Setting, FogExploration, and Adventure documents read-only through MCP.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
    });

    // Removed 'enableWriteAuditLog' setting as it provides no rollback functionality
    // and only creates log entries without user-actionable features

    // ============================================================================
    // SECTION 4: CONNECTION BEHAVIOR
    // ============================================================================

    game.settings.register(this.moduleId, 'enableNotifications', {
      name: 'Show Connection Messages',
      hint: 'Display notifications when connecting/disconnecting from AI model',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
    });

    game.settings.register(this.moduleId, 'autoReconnectEnabled', {
      name: 'Auto-Reconnect on Disconnect',
      hint: 'Automatically try to reconnect if the connection to AI model is lost',
      scope: 'world',
      config: false,
      type: Boolean,
      default: true,
      onChange: this.onConnectionChange.bind(this),
    });

    game.settings.register(this.moduleId, 'heartbeatInterval', {
      name: 'Fallback Reconnect Wake Frequency',
      hint: 'How often the browser wakes a delayed reconnect retry. The persistent server independently owns transport heartbeats.',
      scope: 'world',
      config: false,
      type: Number,
      default: 30,
      range: {
        min: 10,
        max: 120,
        step: 5,
      },
      onChange: this.onConnectionChange.bind(this),
    });

    // Non-configurable settings for internal state
    game.settings.register(this.moduleId, 'lastConnectionState', {
      scope: 'world',
      config: false,
      type: String,
      default: 'disconnected',
    });

    game.settings.register(this.moduleId, 'lastActivity', {
      scope: 'world',
      config: false,
      type: String,
      default: '',
    });

    // Track when we last showed the MCP server notification to avoid spam
    game.settings.register(this.moduleId, 'lastMCPServerNotification', {
      scope: 'world',
      config: false,
      type: String,
      default: '',
    });

    // Roll state storage for persistent roll button states
    game.settings.register(this.moduleId, 'rollStates', {
      scope: 'world',
      config: false,
      type: Object,
      default: {},
      onChange: this.onRollStatesChanged.bind(this),
    });

    // Button to message ID mapping for ChatMessage updates
    game.settings.register(this.moduleId, 'buttonMessageMap', {
      scope: 'world',
      config: false,
      type: Object,
      default: {},
    });

    game.settings.register(this.moduleId, 'migrationVersion', {
      scope: 'world',
      config: false,
      type: Number,
      default: 0,
    });

    registerSettingsMenus(this);
  }

  /**
   * Handle roll states setting changes - fires on all clients for world-scoped settings
   */
  private onRollStatesChanged(_newValue: any): void {
    // No action needed - ChatMessage.update() handles state synchronization automatically
  }

  /**
   * Update connection status display in settings
   */
  updateConnectionStatusDisplay(connected: boolean, _toolCount: number): void {
    try {
      const statusText = connected
        ? `✅ Connected`
        : `❌ Disconnected - Use connection panel to connect`;

      // Update the hint for the enabled setting to show status
      const enabledSetting = (game.settings as any).settings.get(`${this.moduleId}.enabled`);
      if (enabledSetting) {
        enabledSetting.hint = `${enabledSetting.hint.split(' |')[0]} | Status: ${statusText}`;
      }
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to update status display:`, error);
    }
  }

  /**
   * Get current bridge configuration from settings
   */
  getBridgeConfig(): BridgeConfig {
    const connectionType = this.getSetting('connectionType');

    return {
      enabled: this.getSetting('enabled'),
      serverHost: this.getSetting('serverHost'),
      serverPort: this.getSetting('serverPort'),
      namespace: '/foundry-mcp', // Fixed namespace - no user configuration needed
      reconnectAttempts: DEFAULT_CONFIG.RECONNECT_ATTEMPTS, // Use sensible default
      reconnectDelay: DEFAULT_CONFIG.RECONNECT_DELAY, // Use sensible default
      connectionTimeout: DEFAULT_CONFIG.CONNECTION_TIMEOUT, // Use sensible default
      debugLogging: false, // Always false - use browser console for debugging
      connectionType: connectionType as 'auto' | 'webrtc' | 'websocket',
      authToken: String(this.getSetting('authToken') || ''),
      autoReconnect: this.getSetting('autoReconnectEnabled') === true,
    };
  }

  /**
   * Get a specific setting value
   */
  getSetting(key: string): any {
    if (key === LEGACY_WORLD_AUTH_TOKEN_KEY) return this.readWorldLocalAuthToken();
    return game.settings.get(this.moduleId, key);
  }

  /**
   * Set a specific setting value
   */
  async setSetting(key: string, value: any, options?: Record<string, unknown>): Promise<any> {
    if (key === LEGACY_WORLD_AUTH_TOKEN_KEY) {
      const token = String(value ?? '');
      const storageKey = this.getWorldLocalAuthTokenStorageKey();
      if (token) localStorage.setItem(storageKey, token);
      else localStorage.removeItem(storageKey);
      this.onConnectionChange(token, options, game.user?.id);
      return token;
    }
    return (game.settings as any).set(this.moduleId, key, value, options);
  }

  private getWorldLocalAuthTokenStorageKey(): string {
    const worldId = String(game.world?.id || 'unknown-world');
    return `${this.moduleId}.authToken.${encodeURIComponent(worldId)}`;
  }

  private readWorldLocalAuthToken(): string {
    try {
      return localStorage.getItem(this.getWorldLocalAuthTokenStorageKey()) || '';
    } catch {
      return '';
    }
  }

  getCategorySettings(category: SettingsCategory): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const key of CATEGORY_SETTING_KEYS[category]) {
      values[key] = this.getSetting(key);
    }
    return values;
  }

  async applyCategorySettings(
    category: SettingsCategory,
    submittedValues: Record<string, unknown>
  ): Promise<void> {
    const operation = this.categorySaveTail.then(() =>
      this.applyCategorySettingsTransaction(category, submittedValues)
    );
    this.categorySaveTail = operation.catch(() => undefined);
    return operation;
  }

  private async applyCategorySettingsTransaction(
    category: SettingsCategory,
    submittedValues: Record<string, unknown>
  ): Promise<void> {
    const normalizedValues = new Map<string, unknown>();

    for (const key of CATEGORY_SETTING_KEYS[category]) {
      const hasSubmittedValue = Object.prototype.hasOwnProperty.call(submittedValues, key);
      if (!hasSubmittedValue && !BOOLEAN_SETTING_KEYS.has(key)) continue;

      const submittedValue = hasSubmittedValue ? submittedValues[key] : false;
      normalizedValues.set(key, this.normalizeSubmittedSetting(key, submittedValue));
    }

    if (category === 'connection') {
      const candidate = this.getCategorySettings('connection');
      for (const [key, value] of normalizedValues) candidate[key] = value;
      const connectionError = this.getConnectionConfigurationError(candidate);
      if (connectionError) throw new Error(connectionError);
    }

    const originalValues = new Map<string, unknown>();
    const writtenKeys: string[] = [];
    let completed = false;
    let flushAfterRollbackFailure = false;
    let flushRetainedEffectsAfterRollback = false;
    const transactionId = `${this.categoryTransactionInstanceId}:${++this.categoryTransactionSequence}`;
    const transactionOptions = { [CATEGORY_TRANSACTION_OPTION]: transactionId };

    // A category submission has its own transactional batching. Fold any
    // not-yet-applied broadcast changes into the same final effect instead of
    // allowing a debounce timer to restart the bridge between field writes.
    this.externalEnabledDuringCategory = null;
    this.externalConnectionDuringCategory = false;
    this.externalConsoleDuringCategory = false;
    this.activeCategoryTransactionId = transactionId;
    this.applyingCategorySettings = true;
    this.cancelScheduledSettingEffects();
    await this.settingEffectRun;
    this.cancelScheduledSettingEffects();

    const pendingBeforeSave = {
      enabled: this.pendingEnabledChange,
      connection: this.pendingConnectionChange,
      consoleCapture: this.pendingConsoleCaptureChange,
    };

    for (const key of normalizedValues.keys()) {
      originalValues.set(key, this.getSetting(key));
    }

    try {
      for (const [key, value] of normalizedValues) {
        if (Object.is(originalValues.get(key), value)) continue;
        await this.setSetting(key, value, transactionOptions);
        writtenKeys.push(key);
      }
      completed = true;
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const key of writtenKeys.reverse()) {
        try {
          await this.setSetting(key, originalValues.get(key), transactionOptions);
        } catch (rollbackError) {
          rollbackFailures.push(
            `${key}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }

      if (rollbackFailures.length === 0) {
        // Discard callbacks caused by the failed transaction and its rollback,
        // but retain broadcasts pending before it or received from another GM
        // while the transaction was in flight.
        this.pendingEnabledChange = this.externalEnabledDuringCategory ?? pendingBeforeSave.enabled;
        this.pendingConnectionChange =
          pendingBeforeSave.connection || this.externalConnectionDuringCategory;
        this.pendingConsoleCaptureChange =
          pendingBeforeSave.consoleCapture || this.externalConsoleDuringCategory;
        flushRetainedEffectsAfterRollback =
          this.pendingEnabledChange !== null ||
          this.pendingConnectionChange ||
          this.pendingConsoleCaptureChange;
      } else {
        flushAfterRollbackFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to save settings (${message}); rollback also failed for ${rollbackFailures.join(', ')}`
        );
      }
      throw error;
    } finally {
      this.applyingCategorySettings = false;
      try {
        if (completed || flushAfterRollbackFailure || flushRetainedEffectsAfterRollback) {
          await this.flushPendingSettingEffects();
        }
      } finally {
        this.externalEnabledDuringCategory = null;
        this.externalConnectionDuringCategory = false;
        this.externalConsoleDuringCategory = false;
        this.activeCategoryTransactionId = null;
      }
    }
  }

  private normalizeSubmittedSetting(key: string, value: unknown): unknown {
    if (BOOLEAN_SETTING_KEYS.has(key)) {
      return value === true || value === 'true' || value === 'on' || value === 1;
    }

    const bounds = NUMBER_SETTING_BOUNDS[key];
    if (bounds) {
      const numericValue = Number(value);
      const [min, max] = bounds;
      if (!Number.isInteger(numericValue) || numericValue < min || numericValue > max) {
        throw new Error(`${key} must be a number between ${min} and ${max}`);
      }
      return numericValue;
    }

    if (key === 'connectionType') {
      const connectionType = String(value ?? '');
      if (!['auto', 'webrtc', 'websocket'].includes(connectionType)) {
        throw new Error('Connection type must be auto, webrtc, or websocket');
      }
      return connectionType;
    }

    if (key === 'serverHost') {
      const host = String(value ?? '').trim();
      if (!host) throw new Error('Server host cannot be empty');
      return host;
    }

    return String(value ?? '');
  }

  private getConnectionConfigurationError(settings: Record<string, unknown>): string | null {
    const connectionType = String(settings.connectionType ?? 'auto');
    const serverPort = Number(settings.serverPort);
    const serverHost = String(settings.serverHost ?? '').trim();

    if (connectionType !== 'websocket' && serverPort > MAX_WEBRTC_BASE_PORT) {
      return 'Server port must be between 1024 and 65534 for Auto or WebRTC because signaling uses the next port';
    }

    const protocol = (globalThis as any).window?.location?.protocol;
    if (
      connectionType === 'websocket' &&
      protocol === 'https:' &&
      this.isLoopbackHost(serverHost)
    ) {
      return 'WebSocket cannot reach the bundled cleartext loopback bridge from an HTTPS Foundry page; select Auto or WebRTC';
    }

    return null;
  }

  private isLoopbackHost(host: string): boolean {
    const normalized = host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  }

  private async flushPendingSettingEffects(): Promise<void> {
    const enabledChange = this.pendingEnabledChange;
    const connectionChanged = this.pendingConnectionChange;
    const consoleCaptureChanged = this.pendingConsoleCaptureChange;

    this.pendingEnabledChange = null;
    this.pendingConnectionChange = false;
    this.pendingConsoleCaptureChange = false;

    if (!this.isCurrentUserGM()) return;

    const bridge = (globalThis as any).foundryMCPBridge;
    if (bridge) {
      if (enabledChange === false) {
        await bridge.stop?.();
      } else if (enabledChange === true) {
        await bridge.start?.();
      } else if (connectionChanged && this.getSetting('enabled')) {
        await bridge.restart?.();
      }
    }

    if (consoleCaptureChanged) this.applyConsoleCaptureChange();
  }

  private isCurrentUserGM(): boolean {
    return game.user?.isGM === true;
  }

  private isExternalSettingOrigin(userId?: string, options?: unknown): boolean {
    if (this.applyingCategorySettings && this.activeCategoryTransactionId) {
      return (
        (options as Record<string, unknown> | undefined)?.[CATEGORY_TRANSACTION_OPTION] !==
        this.activeCategoryTransactionId
      );
    }
    return Boolean(userId && game.user?.id && userId !== game.user.id);
  }

  private shouldHandleSettingEffect(userId?: string): boolean {
    if (this.suppressSettingEffects || !this.isCurrentUserGM()) return false;
    if (this.applyingCategorySettings) return true;
    const bridge = (globalThis as any).foundryMCPBridge;
    const status = bridge?.getStatus?.();
    if (status?.connectionInfo?.standbyBecauseOwnerActive === true) {
      bridge.refreshStandbyConfiguration?.();
      return false;
    }
    if (status?.connected === true) return true;
    return !userId || !game.user?.id || userId === game.user.id;
  }

  private cancelScheduledSettingEffects(): void {
    if (this.settingEffectTimer === null) return;
    clearTimeout(this.settingEffectTimer);
    this.settingEffectTimer = null;
  }

  /** Coalesce world-setting broadcasts before changing bridge ownership. */
  private scheduleSettingEffects(): void {
    this.cancelScheduledSettingEffects();
    this.settingEffectTimer = setTimeout(() => {
      this.settingEffectTimer = null;
      this.settingEffectRun = this.settingEffectRun
        .then(() => this.flushPendingSettingEffects())
        .catch(error => {
          console.error(`[${this.moduleId}] Failed to apply settings change:`, error);
        });
    }, SETTING_EFFECT_DEBOUNCE_MS);
  }

  /**
   * Get all settings as an object
   */
  getAllSettings(): Record<string, any> {
    // Never expose the authentication secret through status/debug responses.
    const settingKeys = Array.from(new Set(Object.values(CATEGORY_SETTING_KEYS).flat())).filter(
      key => key !== 'authToken'
    );

    const settings: Record<string, any> = {};
    for (const key of settingKeys) {
      settings[key] = this.getSetting(key);
    }

    return settings;
  }

  /**
   * Validate settings for consistency
   */
  validateSettings(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const host = this.getSetting('serverHost');
    if (!host || typeof host !== 'string' || host.trim().length === 0) {
      errors.push('Server host cannot be empty');
    }

    const port = this.getSetting('serverPort');
    const portIsValid =
      typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;
    if (!portIsValid) {
      errors.push('Server port must be between 1024 and 65535');
    } else {
      const connectionError = this.getConnectionConfigurationError({
        connectionType: this.getSetting('connectionType'),
        serverHost: host,
        serverPort: port,
      });
      if (connectionError) errors.push(connectionError);
    }

    const maxActors = this.getSetting('maxActorsPerRequest');
    if (
      !maxActors ||
      typeof maxActors !== 'number' ||
      !Number.isInteger(maxActors) ||
      maxActors < 1 ||
      maxActors > 50
    ) {
      errors.push('Max actors per request must be between 1 and 50');
    }

    const heartbeat = this.getSetting('heartbeatInterval');
    if (
      !heartbeat ||
      typeof heartbeat !== 'number' ||
      !Number.isInteger(heartbeat) ||
      heartbeat < 10 ||
      heartbeat > 120
    ) {
      errors.push('Heartbeat interval must be between 10 and 120 seconds');
    }

    const consoleMaxEntries = this.getSetting('consoleCaptureMaxEntries');
    if (
      !consoleMaxEntries ||
      typeof consoleMaxEntries !== 'number' ||
      !Number.isInteger(consoleMaxEntries) ||
      consoleMaxEntries < 100 ||
      consoleMaxEntries > 10000
    ) {
      errors.push('Console capture max entries must be between 100 and 10000');
    }

    const consoleIdleTimeout = this.getSetting('consoleCaptureIdleTimeout');
    if (
      !consoleIdleTimeout ||
      typeof consoleIdleTimeout !== 'number' ||
      !Number.isInteger(consoleIdleTimeout) ||
      consoleIdleTimeout < 30 ||
      consoleIdleTimeout > 900
    ) {
      errors.push('Console capture idle timeout must be between 30 and 900 seconds');
    }

    const consoleMaxEntryBytes = this.getSetting('consoleCaptureMaxEntryBytes');
    if (
      !consoleMaxEntryBytes ||
      typeof consoleMaxEntryBytes !== 'number' ||
      !Number.isInteger(consoleMaxEntryBytes) ||
      consoleMaxEntryBytes < 512 ||
      consoleMaxEntryBytes > 65536
    ) {
      errors.push('Console capture max entry size must be between 512 and 65536 bytes');
    }

    const scriptTimeoutMs = this.getSetting('scriptTimeoutMs');
    if (
      !scriptTimeoutMs ||
      typeof scriptTimeoutMs !== 'number' ||
      !Number.isInteger(scriptTimeoutMs) ||
      scriptTimeoutMs < 100 ||
      scriptTimeoutMs > 30000
    ) {
      errors.push('Script timeout must be between 100 and 30000 milliseconds');
    }

    const scriptMaxLength = this.getSetting('scriptMaxLength');
    if (
      !scriptMaxLength ||
      typeof scriptMaxLength !== 'number' ||
      !Number.isInteger(scriptMaxLength) ||
      scriptMaxLength < 1000 ||
      scriptMaxLength > 100000
    ) {
      errors.push('Script max length must be between 1000 and 100000 characters');
    }

    for (const [key, label] of [
      ['scriptResultMaxBytes', 'Script result max bytes'],
      ['documentResultMaxBytes', 'Document result max bytes'],
    ] as const) {
      const value = this.getSetting(key);
      if (
        !value ||
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1000 ||
        value > 2000000
      ) {
        errors.push(`${label} must be between 1000 and 2000000 bytes`);
      }
    }

    const auditRetention = this.getSetting('auditRetention');
    if (
      !auditRetention ||
      typeof auditRetention !== 'number' ||
      !Number.isInteger(auditRetention) ||
      auditRetention < 10 ||
      auditRetention > 5000
    ) {
      errors.push('Audit retention must be between 10 and 5000 entries');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Handle enabled setting change
   */
  private onEnabledChange(enabled: boolean, _options?: unknown, userId?: string): void {
    // Disabling is authoritative for every GM client, including a standby
    // connection whose own retry loop would otherwise outlive the world flag.
    if (enabled === false) {
      if (this.suppressSettingEffects || !this.isCurrentUserGM()) return;
      if (this.applyingCategorySettings && this.isExternalSettingOrigin(userId, _options)) {
        this.externalEnabledDuringCategory = false;
      }
      this.pendingEnabledChange = false;
      if (!this.applyingCategorySettings) this.scheduleSettingEffects();
      return;
    }

    if (!this.shouldHandleSettingEffect(userId)) return;

    if (this.applyingCategorySettings && this.isExternalSettingOrigin(userId, _options)) {
      this.externalEnabledDuringCategory = enabled;
    }

    this.pendingEnabledChange = enabled;
    if (this.applyingCategorySettings) {
      return;
    }

    this.scheduleSettingEffects();
  }

  /**
   * Handle connection setting changes
   */
  private onConnectionChange(_value?: unknown, _options?: unknown, userId?: string): void {
    if (!this.shouldHandleSettingEffect(userId)) return;

    if (this.applyingCategorySettings && this.isExternalSettingOrigin(userId, _options)) {
      this.externalConnectionDuringCategory = true;
    }

    this.pendingConnectionChange = true;
    if (this.applyingCategorySettings) {
      return;
    }

    this.scheduleSettingEffects();
  }

  private onConsoleCaptureChange(_value?: unknown, _options?: unknown, _userId?: string): void {
    // Capture policy is local in-memory state, not connection ownership. Keep
    // standby GMs current so a later takeover starts with the latest policy.
    if (this.suppressSettingEffects || !this.isCurrentUserGM()) return;

    if (this.applyingCategorySettings && this.isExternalSettingOrigin(_userId, _options)) {
      this.externalConsoleDuringCategory = true;
    }

    if (this.applyingCategorySettings) {
      this.pendingConsoleCaptureChange = true;
      return;
    }

    this.applyConsoleCaptureChange();
  }

  private applyConsoleCaptureChange(): void {
    const bridge = (globalThis as any).foundryMCPBridge;
    if (!bridge) {
      return;
    }

    if (typeof bridge.refreshCapturePolicy === 'function') {
      bridge.refreshCapturePolicy();
      return;
    }

    // Compatibility fallback for startup or older bridge instances.
    const capture = bridge.consoleCapture;
    if (this.getSetting('enableConsoleCapture')) capture?.restart?.();
    else capture?.stop?.();
  }

  /**
   * Create settings migration for version updates
   */
  /**
   * Get write operation permissions
   */
  getWritePermissions(): {
    allowWriteOperations: boolean;
    maxActorsPerRequest: number;
  } {
    return {
      allowWriteOperations: this.getSetting('allowWriteOperations'),
      maxActorsPerRequest: this.getSetting('maxActorsPerRequest'),
    };
  }

  /**
   * Check if AI model is allowed to perform write operations
   */
  isWriteOperationAllowed(_operation?: string): boolean {
    // Simplified - single permission covers all write operations
    return this.getSetting('allowWriteOperations');
  }

  migrateSettings(_fromVersion: string, _toVersion: string): void {
    // Add migration logic here for future versions
    // For now, no migrations needed as this is initial version
  }

  private readLegacyAuthToken(document: any): string {
    // Foundry's JSON field exposes the already-deserialized Setting value.
    // Prefer it so tokens like "123" or "true" remain strings.
    if (typeof document?.value === 'string') return document.value;

    const storedValue = document?._source?.value;
    if (typeof storedValue !== 'string' || storedValue.length === 0) return '';

    // Defensive compatibility for an older/raw document fixture.
    try {
      const parsedValue: unknown = JSON.parse(storedValue);
      return typeof parsedValue === 'string' ? parsedValue : '';
    } catch {
      return storedValue;
    }
  }

  /** Remove retired settings and move the legacy world auth token client-side. */
  async migrateRemovedFeatureState(): Promise<string[]> {
    if (!this.isCurrentUserGM()) return [];

    const completedVersion = Number(this.getSetting('migrationVersion') || 0);
    if (completedVersion >= CURRENT_MIGRATION_VERSION) return [];

    const worldStorage = (game.settings as any).storage?.get?.('world');
    const removed: string[] = [];

    if (completedVersion < 1) {
      for (const key of REMOVED_WORLD_SETTING_KEYS) {
        const fullKey = `${this.moduleId}.${key}`;
        const document = worldStorage?.getSetting?.(fullKey, null);
        if (!document) continue;
        await document.delete();
        removed.push(key);
      }
    }

    if (completedVersion < 2) {
      const fullKey = `${this.moduleId}.${LEGACY_WORLD_AUTH_TOKEN_KEY}`;
      const legacyDocument = worldStorage?.getSetting?.(fullKey, null);
      if (legacyDocument) {
        const legacyToken = this.readLegacyAuthToken(legacyDocument);
        const currentClientToken = String(this.getSetting(LEGACY_WORLD_AUTH_TOKEN_KEY) || '');

        // setSetting stores this only in the current browser and qualifies it
        // by world id. Never overwrite an explicitly configured token with the
        // obsolete player-readable world value.
        if (legacyToken && !currentClientToken) {
          this.suppressSettingEffects = true;
          try {
            await this.setSetting(LEGACY_WORLD_AUTH_TOKEN_KEY, legacyToken);
          } finally {
            this.suppressSettingEffects = false;
          }
        }

        await legacyDocument.delete();
      }
    }

    await this.setSetting('migrationVersion', CURRENT_MIGRATION_VERSION);
    return removed;
  }

  /**
   * Reset all settings to defaults
   */
  async resetToDefaults(): Promise<void> {
    for (const category of Object.keys(CATEGORY_SETTING_KEYS) as SettingsCategory[]) {
      await this.resetCategorySettings(category);
    }

    ui.notifications.info('MCP Bridge settings have been reset to defaults');
  }

  async resetCategorySettings(category: SettingsCategory): Promise<void> {
    const defaults: Record<string, unknown> = {};
    for (const key of CATEGORY_SETTING_KEYS[category]) {
      const setting = (game.settings as any).settings.get(`${this.moduleId}.${key}`);
      if (setting && 'default' in setting) defaults[key] = setting.default;
    }
    await this.applyCategorySettings(category, defaults);
  }
}
