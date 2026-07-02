import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ServerRegistry } from '../server-registry.js';
import { config } from '../config.js';
import { Logger } from '../logger.js';

export interface ServerManagementToolsOptions {
  registry: ServerRegistry;
  logger: Logger;
}

/**
 * Tools for working with multiple named Foundry server profiles.
 * Agents list the available servers by friendly name and pick which one
 * subsequent tool calls should hit — either by switching the active server
 * or by passing `server: "<name>"` on any individual tool call.
 */
export class ServerManagementTools {
  private registry: ServerRegistry;
  private logger: Logger;

  constructor({ registry, logger }: ServerManagementToolsOptions) {
    this.registry = registry;
    this.logger = logger.child({ component: 'ServerManagementTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'list-foundry-servers',
        description:
          'List configured Foundry server profiles by friendly name, including which is active, which are connected, and the world/module each connection reports. Switch with use-foundry-server, or pass server:"<name>" on any tool call for a one-off override.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'use-foundry-server',
        description:
          'Switch the active Foundry server. All subsequent tool calls hit the selected server until switched again. Use list-foundry-servers to see available names.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Profile name of the server to activate (from list-foundry-servers)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'reconnect-foundry-server',
        description:
          'Restart the listener for a Foundry server profile. Use when a connection is stuck; the Foundry module reconnects automatically within ~30s.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Profile name to restart (defaults to the active server)',
            },
          },
        },
      },
      {
        name: 'reload-foundry-servers-config',
        description:
          'Re-read foundry-servers.json and apply changes without restarting the MCP server: new profiles start, removed profiles stop, changed profiles restart. Unchanged profiles keep their live connections.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    switch (name) {
      case 'list-foundry-servers': {
        const servers = this.registry.list();
        // Enrich connected servers with world + module info (best effort)
        const enriched = await Promise.all(
          servers.map(async server => {
            if (!server.connected) return server;
            const registered = this.registry.get(server.name);
            const caps = await registered?.client.getCapabilities().catch(() => null);
            return caps
              ? {
                  ...server,
                  world: caps.world,
                  system: caps.system,
                  moduleVersion: caps.moduleVersion,
                  foundryVersion: caps.foundryVersion,
                }
              : server;
          })
        );
        return {
          activeServer: this.registry.getActiveName(),
          servers: enriched,
          summary: enriched
            .map((s: any) => {
              const world = s.world
                ? ` — world "${s.world.title}" (${s.system?.id} ${s.system?.version}, module v${s.moduleVersion})`
                : '';
              return `${s.active ? '→ ' : '  '}${s.name} (${s.label}) — port ${s.port}, ${s.connectionType}${s.remoteMode ? ', remote' : ''}: ${s.connected ? 'connected' : 'not connected'}${world}`;
            })
            .join('\n'),
          hint: 'Pass server:"<name>" on any tool call for a one-off override without switching.',
        };
      }
      case 'use-foundry-server': {
        const requested = typeof args?.name === 'string' ? args.name.trim() : '';
        if (!requested) {
          throw new Error('use-foundry-server requires a "name" argument');
        }
        const server = this.registry.setActive(requested);
        this.logger.info('Active server switched via tool', { name: requested });
        const caps = await server.client.getCapabilities().catch(() => null);
        return {
          activeServer: server.name,
          label: server.label,
          connected: server.client.isConnected(),
          ...(caps
            ? { world: caps.world, system: caps.system, moduleVersion: caps.moduleVersion }
            : {}),
          note: server.client.isConnected()
            ? 'Server is connected and ready.'
            : 'Server profile activated, but no Foundry instance is currently connected to it. Ensure that Foundry world is running with the MCP Bridge module enabled and pointed at this port.',
        };
      }
      case 'reconnect-foundry-server': {
        const target =
          (typeof args?.name === 'string' && args.name.trim()) || this.registry.getActiveName();
        const server = await this.registry.reconnect(target);
        return {
          server: server.name,
          restarted: true,
          note: 'Listener restarted. The Foundry module retries automatically (within ~30s); refresh the world tab to reconnect immediately.',
        };
      }
      case 'reload-foundry-servers-config': {
        const diff = await this.registry.reloadConfig(config, this.logger);
        return {
          ...diff,
          activeServer: this.registry.getActiveName(),
          servers: this.registry
            .list()
            .map(s => ({ name: s.name, port: s.port, connected: s.connected })),
        };
      }
      default:
        throw new Error(`Unknown server management tool: ${name}`);
    }
  }
}
