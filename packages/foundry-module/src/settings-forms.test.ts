import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSettingsMenus,
  settingsMenuDefinitions,
  type SettingsFormHost,
} from './settings-forms.js';

class MockApplicationV2 {}

describe('categorized settings menus', () => {
  const registerMenu = vi.fn();
  const notificationsInfo = vi.fn();
  let host: SettingsFormHost;

  beforeEach(() => {
    registerMenu.mockReset();
    notificationsInfo.mockReset();
    host = {
      getCategorySettings: vi.fn(category => ({ category })),
      applyCategorySettings: vi.fn(async () => undefined),
      resetCategorySettings: vi.fn(async () => undefined),
    };

    (globalThis as any).foundry = {
      applications: {
        api: {
          ApplicationV2: MockApplicationV2,
          HandlebarsApplicationMixin: (Base: typeof MockApplicationV2) => class extends Base {},
        },
      },
    };
    (globalThis as any).game = { settings: { registerMenu } };
    (globalThis as any).ui = { notifications: { info: notificationsInfo } };
  });

  afterEach(() => {
    delete (globalThis as any).foundry;
    delete (globalThis as any).game;
    delete (globalThis as any).ui;
  });

  it('registers one GM-only launcher for each category', () => {
    registerSettingsMenus(host);

    expect(registerMenu).toHaveBeenCalledTimes(4);
    expect(registerMenu.mock.calls.map(call => call[1])).toEqual([
      'connectionSettings',
      'permissionsSettings',
      'consoleSettings',
      'advancedSettings',
    ]);

    for (const [, , options] of registerMenu.mock.calls) {
      expect(options.restricted).toBe(true);
      expect(options.type.prototype).toBeInstanceOf(MockApplicationV2);
    }
  });

  it('loads only the selected category and applies submitted values', async () => {
    registerSettingsMenus(host);
    const connectionApplication = registerMenu.mock.calls[0][2].type;
    const instance = new connectionApplication();

    await expect(instance._prepareContext({})).resolves.toMatchObject({
      settings: { category: 'connection' },
    });

    const submitted = { enabled: true, serverPort: 31415 };
    await connectionApplication.DEFAULT_OPTIONS.form.handler(
      {} as SubmitEvent,
      {} as HTMLFormElement,
      { object: submitted }
    );

    expect(host.applyCategorySettings).toHaveBeenCalledWith('connection', submitted);
    expect(notificationsInfo).toHaveBeenCalledWith('Connection settings saved');
  });

  it('uses unique application ids and templates', () => {
    expect(new Set(settingsMenuDefinitions.map(menu => menu.key)).size).toBe(4);
    expect(new Set(settingsMenuDefinitions.map(menu => menu.template)).size).toBe(4);
  });

  it('routes the reset submit action to the selected category', async () => {
    registerSettingsMenus(host);
    const permissionsApplication = registerMenu.mock.calls[1][2].type;

    await permissionsApplication.DEFAULT_OPTIONS.form.handler(
      {} as SubmitEvent,
      {} as HTMLFormElement,
      { object: { _action: 'reset' } }
    );

    expect(host.resetCategorySettings).toHaveBeenCalledWith('permissions');
    expect(host.applyCategorySettings).not.toHaveBeenCalled();
  });
});
