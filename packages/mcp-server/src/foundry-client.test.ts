import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import { FoundryClient } from './foundry-client.js';
import { QueryOutcomeUnknownError, QueryTimeoutError } from './foundry-connector.js';
import { Logger } from './logger.js';

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

afterEach(() => vi.useRealTimers());

describe('FoundryClient timeout classification', () => {
  it('marks timed-out writes as unknown outcome while retaining ordinary read timeouts', async () => {
    const client = new FoundryClient(config.foundry, logger());
    (client as any).connector = {
      isConnected: () => true,
      query: async (method: string) => {
        throw new QueryTimeoutError(method, 45_000);
      },
    };

    await expect(client.query('foundry-mcp-bridge.createActor', {})).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
    await expect(client.query('foundry-mcp-bridge.listActors', {})).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('marks writes with a lost post-send response as unknown outcome', async () => {
    const client = new FoundryClient(config.foundry, logger());
    (client as any).connector = {
      isConnected: () => true,
      query: async (method: string) => {
        throw new QueryOutcomeUnknownError(method);
      },
    };

    await expect(client.query('foundry-mcp-bridge.updateDocument', {})).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
  });

  it('keeps a pre-dispatch send failure as an ordinary query failure', async () => {
    const client = new FoundryClient(config.foundry, logger());
    (client as any).connector = {
      isConnected: () => true,
      query: async () => {
        throw new Error('send failed before dispatch');
      },
    };

    await expect(client.query('foundry-mcp-bridge.updateDocument', {})).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    });
  });
});

describe('FoundryClient reconnect grace', () => {
  it('waits for a bounded reconnect after a recent transport loss', async () => {
    vi.useFakeTimers();
    const client = new FoundryClient(config.foundry, logger());
    let connected = false;
    (client as any).listenerStartedAt = Date.now() - 120_000;
    (client as any).connector = {
      isConnected: () => connected,
      getLastDisconnectAt: () => Date.now() - 1_000,
      query: async () => ({ ok: true }),
    };
    setTimeout(() => {
      connected = true;
    }, 100);

    const resultPromise = client.query('foundry-mcp-bridge.listActors', {});
    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.toEqual({ ok: true });
  });

  it('fails fast when no GM is connected outside startup or recent-disconnect grace', async () => {
    const client = new FoundryClient(config.foundry, logger());
    (client as any).listenerStartedAt = Date.now() - 120_000;
    (client as any).connector = {
      isConnected: () => false,
      getLastDisconnectAt: () => Date.now() - 120_000,
    };

    await expect(client.query('foundry-mcp-bridge.listActors', {})).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });
});

describe('FoundryClient capability cache ownership', () => {
  it('refetches capabilities after a replacement module transport connects', async () => {
    const client = new FoundryClient(config.foundry, logger());
    let generation = 1;
    let world = 'world-a';
    const query = vi.fn(async () => ({
      moduleId: 'foundry-mcp-bridge',
      moduleVersion: '0.12.0',
      foundryVersion: '13',
      system: { id: 'dnd5e', version: '5' },
      world: { id: world, title: world },
      handlers: [],
    }));
    (client as any).connector = {
      isConnected: () => true,
      getConnectionGeneration: () => generation,
      query,
    };

    await expect(client.getCapabilities()).resolves.toMatchObject({ world: { id: 'world-a' } });
    await expect(client.getCapabilities()).resolves.toMatchObject({ world: { id: 'world-a' } });
    expect(query).toHaveBeenCalledOnce();

    generation = 2;
    world = 'world-b';
    await expect(client.getCapabilities()).resolves.toMatchObject({ world: { id: 'world-b' } });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
