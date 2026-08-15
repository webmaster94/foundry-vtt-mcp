import { MODULE_ID } from './constants.js';

export type SettingsCategory = 'connection' | 'permissions' | 'console' | 'advanced';

export interface SettingsFormHost {
  getCategorySettings(category: SettingsCategory): Record<string, unknown>;
  applyCategorySettings(category: SettingsCategory, values: Record<string, unknown>): Promise<void>;
  resetCategorySettings(category: SettingsCategory): Promise<void>;
}

interface SettingsMenuDefinition {
  key: string;
  category: SettingsCategory;
  name: string;
  label: string;
  hint: string;
  icon: string;
  template: string;
  width: number;
}

const SETTINGS_MENUS: SettingsMenuDefinition[] = [
  {
    key: 'connectionSettings',
    category: 'connection',
    name: 'Connection',
    label: 'Configure Connection',
    hint: 'Server, transport, authentication, recovery, and connection notification settings.',
    icon: 'fa-solid fa-plug-circle-bolt',
    template: `modules/${MODULE_ID}/templates/settings/connection-settings.hbs`,
    width: 600,
  },
  {
    key: 'permissionsSettings',
    category: 'permissions',
    name: 'Permissions & Safety',
    label: 'Configure Permissions & Safety',
    hint: 'Write access, bulk limits, protected document types, auditing, and event delivery.',
    icon: 'fa-solid fa-shield-halved',
    template: `modules/${MODULE_ID}/templates/settings/permissions-settings.hbs`,
    width: 600,
  },
  {
    key: 'consoleSettings',
    category: 'console',
    name: 'Console & Diagnostics',
    label: 'Configure Console & Diagnostics',
    hint: 'Bounded browser-console capture and its idle-suspension policy.',
    icon: 'fa-solid fa-terminal',
    template: `modules/${MODULE_ID}/templates/settings/console-settings.hbs`,
    width: 600,
  },
  {
    key: 'advancedSettings',
    category: 'advanced',
    name: 'Advanced API',
    label: 'Configure Advanced API',
    hint: 'Browser script execution and serialized response limits for trusted MCP clients.',
    icon: 'fa-solid fa-code',
    template: `modules/${MODULE_ID}/templates/settings/advanced-settings.hbs`,
    width: 600,
  },
];

function createSettingsApplication(
  definition: SettingsMenuDefinition,
  host: SettingsFormHost
): new (...args: any[]) => any {
  const applicationsApi = (globalThis as any).foundry?.applications?.api;
  const ApplicationV2 = applicationsApi?.ApplicationV2;
  const HandlebarsApplicationMixin = applicationsApi?.HandlebarsApplicationMixin;

  if (!ApplicationV2 || !HandlebarsApplicationMixin) {
    throw new Error('Foundry ApplicationV2 settings API is unavailable');
  }

  const BaseApplication = HandlebarsApplicationMixin(ApplicationV2);
  const category = definition.category;

  return class MCPSettingsApplication extends BaseApplication {
    static DEFAULT_OPTIONS = {
      id: `foundry-mcp-${definition.category}-settings`,
      tag: 'form',
      window: {
        title: `Foundry MCP Bridge: ${definition.name}`,
        icon: definition.icon,
        contentClasses: ['standard-form', 'mcp-settings-application'],
      },
      position: {
        width: definition.width,
        height: 'auto',
      },
      form: {
        closeOnSubmit: true,
        handler: async (
          event: SubmitEvent,
          _form: HTMLFormElement,
          formData: { object?: Record<string, unknown> }
        ) => {
          const values = formData.object ?? {};
          const submitterAction = (event.submitter as HTMLButtonElement | null)?.value;
          if (submitterAction === 'reset' || values._action === 'reset') {
            await host.resetCategorySettings(category);
            ui.notifications?.info(`${definition.name} settings reset to defaults`);
          } else {
            await host.applyCategorySettings(category, values);
            ui.notifications?.info(`${definition.name} settings saved`);
          }
        },
      },
    };

    static PARTS = {
      form: {
        template: definition.template,
        scrollable: [''],
      },
    };

    async _prepareContext(_options: unknown): Promise<Record<string, unknown>> {
      const bridgeStatus = (globalThis as any).foundryMCPBridge?.getStatus?.();
      return {
        settings: host.getCategorySettings(category),
        connectionStatus:
          category === 'connection'
            ? {
                connected: bridgeStatus?.connected === true,
                state: bridgeStatus?.connectionState ?? 'disconnected',
                type: bridgeStatus?.connectionInfo?.type ?? null,
              }
            : null,
        connectionTypes: {
          auto: 'Auto (Recommended)',
          webrtc: 'WebRTC (Internet / HTTPS)',
          websocket: 'WebSocket (Local or WSS)',
        },
      };
    }
  };
}

export function registerSettingsMenus(host: SettingsFormHost): void {
  for (const definition of SETTINGS_MENUS) {
    (game.settings as any).registerMenu(MODULE_ID, definition.key, {
      name: definition.name,
      label: definition.label,
      hint: definition.hint,
      icon: definition.icon,
      type: createSettingsApplication(definition, host),
      restricted: true,
    });
  }
}

export const settingsMenuDefinitions = SETTINGS_MENUS.map(definition => ({ ...definition }));
