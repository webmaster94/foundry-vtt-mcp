import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { ServerRegistry } from './server-registry.js';
import {
  CONTROL_PROTOCOL_VERSION,
  type BackendPingResult,
  type BackendStatusResult,
  type ReloadServersResult,
} from './control-protocol.js';

export type DesktopControlMethod =
  | 'get_status'
  | 'set_active_server'
  | 'reconnect_server'
  | 'reload_servers_config';

const DESKTOP_CONTROL_METHODS = new Set<DesktopControlMethod>([
  'get_status',
  'set_active_server',
  'reconnect_server',
  'reload_servers_config',
]);

export function isDesktopControlMethod(value: string): value is DesktopControlMethod {
  return DESKTOP_CONTROL_METHODS.has(value as DesktopControlMethod);
}

/** Narrow, non-MCP administration surface used by the desktop main process. */
export class DesktopControlService {
  constructor(
    private readonly registry: ServerRegistry,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly getPingResult: () => BackendPingResult
  ) {}

  async handle(method: DesktopControlMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'get_status':
        return this.getStatus();
      case 'set_active_server': {
        const name = this.readOptionalName(params);
        if (!name) throw new Error('set_active_server requires a non-empty name');
        this.registry.setActive(name);
        return { activeServer: this.registry.getActiveName() };
      }
      case 'reconnect_server': {
        const name = this.readOptionalName(params) ?? this.registry.getActiveName();
        const server = await this.registry.reconnect(name);
        return { server: server.name, restarted: true as const };
      }
      case 'reload_servers_config':
        return this.reloadServers();
    }
  }

  private getStatus(): BackendStatusResult {
    const registryStatus = this.registry.getStatus();
    const { ok: _ok, ...backend } = this.getPingResult();
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      backend,
      config: registryStatus.config,
      activeServer: registryStatus.activeServer,
      servers: registryStatus.servers,
    };
  }

  private async reloadServers(): Promise<ReloadServersResult> {
    const diff = await this.registry.reloadConfig(this.config, this.logger);
    return {
      ...diff,
      activeServer: this.registry.getActiveName(),
      servers: this.registry.list().map(server => ({
        name: server.name,
        port: server.port,
        connected: server.connected,
      })),
    };
  }

  private readOptionalName(params: unknown): string | null {
    if (!params || typeof params !== 'object') return null;
    const candidate = (params as { name?: unknown }).name;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  }
}
