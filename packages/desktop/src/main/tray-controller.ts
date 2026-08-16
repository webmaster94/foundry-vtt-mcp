import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import { DesktopStatus } from '../shared/contracts.js';
import { countListenerFailures } from '../shared/connection-health.js';

export interface TrayIcons {
  connected: string | NativeImage;
  waiting: string | NativeImage;
  error: string | NativeImage;
}

export interface TrayActions {
  open(): void;
  exit(): void;
}

export interface TrayMenuBuilder {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
}

function summary(status: DesktopStatus): string {
  if (status.state === 'starting') return 'Starting backend';
  if (status.state !== 'online' || !status.status) return status.message ?? 'Backend unavailable';
  const failed = countListenerFailures(status.status);
  if (failed > 0) {
    return `${failed} connection listener${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} attention`;
  }
  const connected = status.status.servers.filter(server => server.connected).length;
  return `${connected} of ${status.status.servers.length} Foundry connections active`;
}

function stateIcon(status: DesktopStatus, icons: TrayIcons): string | NativeImage {
  if (status.state === 'online' && status.status && countListenerFailures(status.status) > 0) {
    return icons.error;
  }
  if (status.state === 'online' && status.status?.servers.some(server => server.connected)) {
    return icons.connected;
  }
  if (status.state === 'starting' || status.state === 'online') return icons.waiting;
  return icons.error;
}

export class TrayController {
  constructor(
    private readonly tray: Tray,
    private readonly menu: TrayMenuBuilder,
    private readonly icons: TrayIcons,
    private readonly actions: TrayActions
  ) {
    this.tray.on('click', () => actions.open());
    this.tray.on('double-click', () => actions.open());
  }

  update(status: DesktopStatus): void {
    const statusSummary = summary(status);
    this.tray.setImage(stateIcon(status, this.icons));
    this.tray.setToolTip(`FoundryVTT MCP Bridge — ${statusSummary}`);
    this.tray.setContextMenu(
      this.menu.buildFromTemplate([
        { label: 'Open FoundryVTT MCP Bridge', click: () => this.actions.open() },
        { label: statusSummary, enabled: false },
        { type: 'separator' },
        { label: 'Exit', click: () => this.actions.exit() },
      ])
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
