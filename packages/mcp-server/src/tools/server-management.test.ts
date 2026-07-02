import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServerRegistry } from '../server-registry.js';
import { ServerManagementTools } from './server-management.js';
import { config } from '../config.js';
import { Logger } from '../logger.js';

vi.mock('../foundry-client.js', () => {
  return {
    FoundryClient: class {
      connected = false;
      constructor(
        public foundryConfig: any,
        public logger: any
      ) {}
      async connect() {
        this.connected = true;
      }
      disconnect() {
        this.connected = false;
      }
      isConnected() {
        return this.connected;
      }
      getConnectionInfo() {
        return { type: null, state: this.connected ? 'connected' : 'disconnected' };
      }
      async query(method: string) {
        return { method, port: this.foundryConfig.port };
      }
      async getCapabilities() {
        return this.connected
          ? {
              moduleId: 'foundry-mcp-bridge',
              moduleVersion: '0.10.0',
              foundryVersion: '13.351',
              system: { id: 'dnd5e', version: '5.3.1' },
              world: { id: 'test', title: 'Test World' },
              handlers: ['ping'],
            }
          : null;
      }
    },
  };
});

const logger = new Logger({ level: 'error', format: 'simple', enableConsole: false });

function writeServersFile(contents: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmcp-test-')), 'servers.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe('ServerRegistry', () => {
  beforeEach(() => {
    delete process.env.FOUNDRY_SERVERS_CONFIG;
  });

  it('synthesizes a default profile when no config file exists', () => {
    const registry = new ServerRegistry(config, logger, path.join(os.tmpdir(), 'nope.json'));
    const servers = registry.list();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('default');
    expect(servers[0]!.active).toBe(true);
    expect(servers[0]!.port).toBe(config.foundry.port);
  });

  it('loads named profiles and honors defaultServer', () => {
    const file = writeServersFile({
      defaultServer: 'local',
      servers: {
        forge: { label: 'Forge World', port: 31415, connectionType: 'webrtc', remoteMode: true },
        local: { label: 'Local Dev', port: 31417, connectionType: 'websocket' },
      },
    });
    const registry = new ServerRegistry(config, logger, file);
    expect(registry.getActiveName()).toBe('local');
    const names = registry.list().map(s => s.name);
    expect(names).toEqual(['forge', 'local']);
  });

  it('skips profiles with duplicate ports', () => {
    const file = writeServersFile({
      servers: {
        a: { port: 31415 },
        b: { port: 31415 },
      },
    });
    const registry = new ServerRegistry(config, logger, file);
    expect(registry.list()).toHaveLength(1);
    expect(registry.getActiveName()).toBe('a');
  });

  it('routes queries through the active profile and switches', async () => {
    const file = writeServersFile({
      servers: {
        forge: { port: 31415 },
        local: { port: 31417 },
      },
    });
    const registry = new ServerRegistry(config, logger, file);
    expect(await registry.routingClient.query('x')).toMatchObject({ port: 31415 });
    registry.setActive('local');
    expect(await registry.routingClient.query('x')).toMatchObject({ port: 31417 });
  });

  it('throws a helpful error for unknown server names', () => {
    const registry = new ServerRegistry(config, logger, path.join(os.tmpdir(), 'nope.json'));
    expect(() => registry.setActive('missing')).toThrow(/Available servers: default/);
  });
});

describe('ServerManagementTools', () => {
  it('lists servers with active/connected status', async () => {
    const file = writeServersFile({
      defaultServer: 'forge',
      servers: {
        forge: { label: 'Forge World', port: 31415 },
        local: { label: 'Local Dev', port: 31417 },
      },
    });
    const registry = new ServerRegistry(config, logger, file);
    await registry.connectAll();
    const tools = new ServerManagementTools({ registry, logger });

    const result = await tools.handleToolCall('list-foundry-servers', {});
    expect(result.activeServer).toBe('forge');
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({ name: 'forge', active: true, connected: true });
    expect(result.summary).toContain('Forge World');
  });

  it('switches the active server', async () => {
    const file = writeServersFile({
      servers: {
        forge: { port: 31415 },
        local: { port: 31417 },
      },
    });
    const registry = new ServerRegistry(config, logger, file);
    const tools = new ServerManagementTools({ registry, logger });

    const result = await tools.handleToolCall('use-foundry-server', { name: 'local' });
    expect(result.activeServer).toBe('local');
    expect(registry.getActiveName()).toBe('local');
  });

  it('rejects unknown names with available list', async () => {
    const registry = new ServerRegistry(config, logger, path.join(os.tmpdir(), 'nope.json'));
    const tools = new ServerManagementTools({ registry, logger });
    await expect(tools.handleToolCall('use-foundry-server', { name: 'bogus' })).rejects.toThrow(
      /Available servers/
    );
  });

  it('exposes all four tool definitions', () => {
    const registry = new ServerRegistry(config, logger, path.join(os.tmpdir(), 'nope.json'));
    const tools = new ServerManagementTools({ registry, logger });
    expect(tools.getToolDefinitions().map(t => t.name)).toEqual([
      'list-foundry-servers',
      'use-foundry-server',
      'reconnect-foundry-server',
      'reload-foundry-servers-config',
    ]);
  });
});
