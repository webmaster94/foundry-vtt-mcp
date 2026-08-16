import type { Menu, MenuItemConstructorOptions, Tray } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { DesktopStatus } from '../src/shared/contracts.js';
import { TrayController } from '../src/main/tray-controller.js';

class FakeTray {
  image = '';
  tooltip = '';
  contextMenu: Menu | null = null;
  destroyed = false;
  readonly listeners = new Map<string, () => void>();

  on(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  setImage(image: string): void {
    this.image = image;
  }

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip;
  }

  setContextMenu(menu: Menu): void {
    this.contextMenu = menu;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const onlineStatus: DesktopStatus = {
  state: 'online',
  checkedAt: '2026-08-15T00:00:00.000Z',
  status: {
    protocolVersion: 1,
    backend: { pid: 42, startedAt: 'now', entrySig: 'abc' },
    config: { path: 'config.json', exists: true, source: 'file' },
    activeServer: 'local',
    servers: [
      {
        name: 'local',
        label: 'Local',
        host: 'localhost',
        port: 31415,
        connectionType: 'auto',
        remoteMode: false,
        active: true,
        connected: true,
        connectionInfo: null,
        cachedCapabilities: null,
      },
    ],
  },
};

describe('TrayController', () => {
  it('shows connection state and exposes Open and Exit actions', () => {
    const tray = new FakeTray();
    let menuTemplate: MenuItemConstructorOptions[] = [];
    const menu = {
      buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => {
        menuTemplate = template;
        return {} as Menu;
      }),
    };
    const actions = { open: vi.fn(), exit: vi.fn() };
    const controller = new TrayController(
      tray as unknown as Tray,
      menu,
      { connected: 'connected.png', waiting: 'waiting.png', error: 'error.png' },
      actions
    );

    controller.update(onlineStatus);
    expect(tray.image).toBe('connected.png');
    expect(tray.tooltip).toContain('1 of 1 Foundry connections active');
    (menuTemplate[0]?.click as (() => void) | undefined)?.();
    (menuTemplate[3]?.click as (() => void) | undefined)?.();
    expect(actions.open).toHaveBeenCalledOnce();
    expect(actions.exit).toHaveBeenCalledOnce();

    tray.listeners.get('click')?.();
    expect(actions.open).toHaveBeenCalledTimes(2);
    controller.destroy();
    expect(tray.destroyed).toBe(true);
  });

  it('uses waiting and error artwork for non-connected states', () => {
    const tray = new FakeTray();
    const menu = { buildFromTemplate: () => ({}) as Menu };
    const controller = new TrayController(
      tray as unknown as Tray,
      menu,
      { connected: 'connected.png', waiting: 'waiting.png', error: 'error.png' },
      { open: vi.fn(), exit: vi.fn() }
    );

    controller.update({ ...onlineStatus, status: { ...onlineStatus.status!, servers: [] } });
    expect(tray.image).toBe('waiting.png');
    controller.update({
      state: 'offline',
      checkedAt: onlineStatus.checkedAt,
      status: null,
      message: 'Unavailable',
    });
    expect(tray.image).toBe('error.png');
  });

  it('uses error artwork when any online listener failed to start', () => {
    const tray = new FakeTray();
    let menuTemplate: MenuItemConstructorOptions[] = [];
    const menu = {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        menuTemplate = template;
        return {} as Menu;
      },
    };
    const controller = new TrayController(
      tray as unknown as Tray,
      menu,
      { connected: 'connected.png', waiting: 'waiting.png', error: 'error.png' },
      { open: vi.fn(), exit: vi.fn() }
    );
    const failedStatus: DesktopStatus = {
      ...onlineStatus,
      status: {
        ...onlineStatus.status!,
        servers: [
          {
            ...onlineStatus.status!.servers[0],
            connected: false,
            connectionInfo: {
              listener: { lastError: { message: 'Port is already in use', at: 1234 } },
            },
          },
        ],
      },
    };

    controller.update(failedStatus);
    expect(tray.image).toBe('error.png');
    expect(tray.tooltip).toContain('1 connection listener needs attention');
    expect(menuTemplate[1]?.label).toContain('needs attention');
  });
});
