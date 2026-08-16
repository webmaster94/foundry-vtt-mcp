import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import { Logger } from './logger.js';

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  failConnectPorts: new Set<number>(),
  connectGates: new Map<number, Promise<void>>(),
  connectedPorts: new Set<number>(),
  capabilityRefreshPorts: [] as number[],
}));

vi.mock('./foundry-client.js', () => ({
  FoundryClient: class {
    onBridgeEvent: ((event: any) => void) | null = null;
    private port: number;
    constructor(foundryConfig: { port: number }) {
      this.port = foundryConfig.port;
    }
    async connect(): Promise<void> {
      lifecycle.events.push(`connect:${this.port}`);
      const gate = lifecycle.connectGates.get(this.port);
      if (gate) await gate;
      if (lifecycle.failConnectPorts.has(this.port)) {
        throw new Error(`simulated bind failure on ${this.port}`);
      }
      lifecycle.connectedPorts.add(this.port);
    }
    async disconnect(): Promise<void> {
      lifecycle.events.push('disconnect-start');
      await new Promise(resolve => setTimeout(resolve, 10));
      lifecycle.connectedPorts.delete(this.port);
      lifecycle.events.push('disconnect-finish');
    }
    setEventHandler(handler: ((event: any) => void) | null): void {
      this.onBridgeEvent = handler;
    }
    isConnected(): boolean {
      return false;
    }
    getConnectionInfo(): Record<string, never> {
      return {};
    }
    getCachedCapabilities(): null {
      return null;
    }
    refreshCapabilitiesInBackground(): void {
      lifecycle.capabilityRefreshPorts.push(this.port);
    }
  },
}));

import { ServerRegistry } from './server-registry.js';
import { runWithServer } from './server-registry.js';
import { GameActionTools } from './tools/game-actions.js';

const tempDirectories: string[] = [];

function logger(): Logger {
  return {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as unknown as Logger;
}

function serversFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-registry-test-'));
  tempDirectories.push(directory);
  const file = join(directory, 'servers.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

afterEach(() => {
  delete process.env.FOUNDRY_SERVERS_CONFIG;
  lifecycle.events.length = 0;
  lifecycle.failConnectPorts.clear();
  lifecycle.connectGates.clear();
  lifecycle.connectedPorts.clear();
  lifecycle.capabilityRefreshPorts.length = 0;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ServerRegistry lifecycle', () => {
  it('reports the exact override path and never exposes profile auth tokens', () => {
    const secret = 'super-secret-profile-token';
    const file = serversFile({
      defaultServer: 'alpha',
      servers: {
        alpha: {
          port: 32090,
          connectionType: 'websocket',
          authToken: secret,
        },
      },
    });
    const registry = new ServerRegistry(config, logger(), file);
    (registry.get('alpha')!.client as any).getCachedCapabilities = () => ({
      moduleId: 'foundry-mcp-bridge',
      moduleVersion: '0.12.0',
      foundryVersion: '14',
      system: { id: 'dnd5e', version: '5', authToken: 'nested-system-secret' },
      world: { id: 'test', title: 'Test', authToken: 'nested-world-secret' },
      handlers: ['secretly-large-handler-list'],
    });

    const status = registry.getStatus();
    expect(status.config).toEqual({ path: file, exists: true, source: 'file' });
    expect(status.activeServer).toBe('alpha');
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status)).not.toContain('authToken');
    expect(JSON.stringify(status)).not.toContain('nested-system-secret');
    expect(JSON.stringify(status)).not.toContain('nested-world-secret');
    expect(JSON.stringify(status)).not.toContain('handlers');
    expect(lifecycle.capabilityRefreshPorts).toEqual([]);

    registry.refreshCapabilityCaches();
    expect(lifecycle.capabilityRefreshPorts).toEqual([32090]);
  });

  it('retains a constructor config override for later reloads', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: { alpha: { port: 32091, connectionType: 'websocket' } },
    });
    const registry = new ServerRegistry(config, logger(), file);
    writeFileSync(
      file,
      JSON.stringify({
        defaultServer: 'alpha',
        servers: { alpha: { port: 32092, connectionType: 'websocket' } },
      })
    );

    await expect(registry.reloadConfig(config, logger())).resolves.toMatchObject({
      changed: ['alpha'],
    });
    expect(registry.list().map(server => server.port)).toEqual([32092]);
    expect(registry.getConfigFilePath()).toBe(file);
  });

  it('rejects main/signaling collisions across profiles', () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: {
        alpha: { port: 32100, connectionType: 'auto' },
        beta: { port: 32101, connectionType: 'websocket' },
      },
    });

    const registry = new ServerRegistry(config, logger(), file);

    expect(registry.list().map(server => server.name)).toEqual(['alpha']);
  });

  it('awaits disconnect completion before reconnecting a profile', async () => {
    const file = serversFile({
      servers: { alpha: { port: 32200, connectionType: 'websocket' } },
    });
    const registry = new ServerRegistry(config, logger(), file);

    await registry.reconnect('alpha');

    expect(lifecycle.events).toEqual(['disconnect-start', 'disconnect-finish', 'connect:32200']);
  });

  it('keeps live profiles untouched when a reload has a cross-listener port conflict', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: {
        alpha: { port: 32300, connectionType: 'auto' },
        beta: { port: 32302, connectionType: 'websocket' },
      },
    });
    process.env.FOUNDRY_SERVERS_CONFIG = file;
    const registry = new ServerRegistry(config, logger());
    const before = registry.list().map(server => ({ name: server.name, port: server.port }));
    writeFileSync(
      file,
      JSON.stringify({
        defaultServer: 'alpha',
        servers: {
          alpha: { port: 32300, connectionType: 'auto' },
          beta: { port: 32301, connectionType: 'websocket' },
        },
      })
    );

    await expect(registry.reloadConfig(config, logger())).rejects.toThrow('conflicts');

    expect(registry.list().map(server => ({ name: server.name, port: server.port }))).toEqual(
      before
    );
    expect(lifecycle.events).toEqual([]);
  });

  it('rejects a malformed selected config without touching healthy profiles', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: {
        alpha: { port: 32310, connectionType: 'websocket' },
        beta: { port: 32311, connectionType: 'websocket' },
      },
    });
    process.env.FOUNDRY_SERVERS_CONFIG = file;
    const registry = new ServerRegistry(config, logger());
    const before = registry.list().map(server => ({ name: server.name, port: server.port }));
    writeFileSync(file, '{"defaultServer":');

    await expect(registry.reloadConfig(config, logger())).rejects.toThrow(
      'Invalid Foundry servers config'
    );

    expect(registry.list().map(server => ({ name: server.name, port: server.port }))).toEqual(
      before
    );
    expect(lifecycle.events).toEqual([]);
  });

  it('restores a healthy changed profile when its replacement cannot start', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: { alpha: { port: 32400, connectionType: 'websocket' } },
    });
    process.env.FOUNDRY_SERVERS_CONFIG = file;
    const registry = new ServerRegistry(config, logger());
    writeFileSync(
      file,
      JSON.stringify({
        defaultServer: 'alpha',
        servers: { alpha: { port: 32401, connectionType: 'websocket' } },
      })
    );
    lifecycle.failConnectPorts.add(32401);

    await expect(registry.reloadConfig(config, logger())).rejects.toThrow('simulated bind failure');

    expect(registry.list().map(server => ({ name: server.name, port: server.port }))).toEqual([
      { name: 'alpha', port: 32400 },
    ]);
    expect(lifecycle.events).toEqual([
      'disconnect-start',
      'disconnect-finish',
      'connect:32401',
      'disconnect-start',
      'disconnect-finish',
      'connect:32400',
    ]);
  });

  it('applies a default-only reload without restarting unchanged profiles', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: {
        alpha: { port: 32500, connectionType: 'websocket' },
        beta: { port: 32501, connectionType: 'websocket' },
      },
    });
    process.env.FOUNDRY_SERVERS_CONFIG = file;
    const registry = new ServerRegistry(config, logger());
    expect(registry.list().find(server => server.active)?.name).toBe('alpha');
    writeFileSync(
      file,
      JSON.stringify({
        defaultServer: 'beta',
        servers: {
          alpha: { port: 32500, connectionType: 'websocket' },
          beta: { port: 32501, connectionType: 'websocket' },
        },
      })
    );

    await expect(registry.reloadConfig(config, logger())).resolves.toMatchObject({
      added: [],
      removed: [],
      changed: [],
      unchanged: ['alpha', 'beta'],
    });

    expect(registry.list().find(server => server.active)?.name).toBe('beta');
    expect(lifecycle.events).toEqual([]);
  });

  it('routes recent-event reads and waits to exactly one selected profile', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: {
        alpha: { port: 32600, connectionType: 'websocket' },
        beta: { port: 32601, connectionType: 'websocket' },
      },
    });
    const registry = new ServerRegistry(config, logger(), file);
    (registry.get('alpha')!.client as any).onBridgeEvent({
      type: 'combat-started',
      data: { world: 'alpha' },
    });
    (registry.get('beta')!.client as any).onBridgeEvent({
      type: 'chat-message',
      data: { world: 'beta' },
    });
    const tools = new GameActionTools({
      foundryClient: registry.routingClient,
      registry,
      logger: logger(),
    });

    const activeRecent = await tools.handleToolCall('get-recent-events', { sinceSeq: 0 });
    expect(activeRecent.events).toHaveLength(1);
    expect(activeRecent.events[0]).toMatchObject({ server: 'alpha' });

    const betaRecent = await runWithServer('beta', () =>
      tools.handleToolCall('get-recent-events', { sinceSeq: 0 })
    );
    expect(betaRecent.events).toHaveLength(1);
    expect(betaRecent.events[0]).toMatchObject({ server: 'beta' });

    const betaWait = await runWithServer('beta', () =>
      tools.handleToolCall('wait-for-event', { sinceSeq: 0, timeoutMs: 1_000 })
    );
    expect(betaWait).toMatchObject({
      matched: true,
      events: [expect.objectContaining({ server: 'beta' })],
    });
  });

  it('serializes overlapping reloads and leaves no orphan replacement listener', async () => {
    const file = serversFile({
      defaultServer: 'alpha',
      servers: { alpha: { port: 32700, connectionType: 'websocket' } },
    });
    process.env.FOUNDRY_SERVERS_CONFIG = file;
    const registry = new ServerRegistry(config, logger());
    let releaseFirst!: () => void;
    lifecycle.connectGates.set(
      32701,
      new Promise<void>(resolve => {
        releaseFirst = resolve;
      })
    );
    writeFileSync(
      file,
      JSON.stringify({
        defaultServer: 'alpha',
        servers: { alpha: { port: 32701, connectionType: 'websocket' } },
      })
    );

    const firstReload = registry.reloadConfig(config, logger());
    await vi.waitFor(() => expect(lifecycle.events).toContain('connect:32701'));
    writeFileSync(
      file,
      JSON.stringify({
        defaultServer: 'alpha',
        servers: { alpha: { port: 32702, connectionType: 'websocket' } },
      })
    );
    const secondReload = registry.reloadConfig(config, logger());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lifecycle.events).not.toContain('connect:32702');

    releaseFirst();
    await Promise.all([firstReload, secondReload]);

    expect(registry.list().map(server => server.port)).toEqual([32702]);
    expect(lifecycle.connectedPorts).toEqual(new Set([32702]));
  });
});
