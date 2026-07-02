import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ServerRegistry } from '../server-registry.js';
import { Logger } from '../logger.js';

export interface ServerManagementToolsOptions {
  registry: ServerRegistry;
  logger: Logger;
}

/**
 * Tools for working with multiple named Foundry server profiles.
 * Agents list the available servers by friendly name and pick which one
 * subsequent tool calls should hit.
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
          'List configured Foundry server profiles by friendly name, including which is active and which are connected. Use use-foundry-server to switch the target of all other tools.',
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
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    switch (name) {
      case 'list-foundry-servers': {
        const servers = this.registry.list();
        return {
          activeServer: this.registry.getActiveName(),
          servers,
          summary: servers
            .map(
              s =>
                `${s.active ? '→ ' : '  '}${s.name} (${s.label}) — port ${s.port}, ${s.connectionType}${s.remoteMode ? ', remote' : ''}: ${s.connected ? 'connected' : 'not connected'}`
            )
            .join('\n'),
        };
      }
      case 'use-foundry-server': {
        const requested = typeof args?.name === 'string' ? args.name.trim() : '';
        if (!requested) {
          throw new Error('use-foundry-server requires a "name" argument');
        }
        const server = this.registry.setActive(requested);
        this.logger.info('Active server switched via tool', { name: requested });
        return {
          activeServer: server.name,
          label: server.label,
          connected: server.client.isConnected(),
          connectionInfo: server.client.getConnectionInfo(),
          note: server.client.isConnected()
            ? 'Server is connected and ready.'
            : 'Server profile activated, but no Foundry instance is currently connected to it. Ensure that Foundry world is running with the MCP Bridge module enabled and pointed at this port.',
        };
      }
      default:
        throw new Error(`Unknown server management tool: ${name}`);
    }
  }
}
