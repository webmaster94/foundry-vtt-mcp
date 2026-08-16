import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigApplyError,
  ConfigConflictError,
  ConfigStore,
  ConfigStoreOptions,
} from '../src/main/config-store.js';
import {
  createDefaultServersConfig,
  validateServersConfig,
} from '../src/main/config-validation.js';
import { ServersConfig } from '../src/shared/contracts.js';

const temporaryRoots: string[] = [];

async function createStore(options: ConfigStoreOptions = {}): Promise<ConfigStore<ServersConfig>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-mcp-desktop-'));
  temporaryRoots.push(root);
  return new ConfigStore(
    path.join(root, 'foundry-servers.json'),
    validateServersConfig,
    createDefaultServersConfig,
    options
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('ConfigStore', () => {
  it('creates, hashes, backs up, and atomically replaces a configuration', async () => {
    const store = await createStore();
    const initial = await store.ensure();
    expect(initial.exists).toBe(true);
    expect(initial.hash).toMatch(/^[a-f0-9]{64}$/);

    const value: ServersConfig = {
      defaultServer: 'forge',
      servers: {
        forge: { label: 'Forge', port: 31500, connectionType: 'webrtc' },
      },
    };
    const saved = await store.save(value, { expectedHash: initial.hash });
    expect(saved.changed).toBe(true);
    expect(saved.backupPath).toBe(store.backupPath);
    expect(JSON.parse(await fs.readFile(store.backupPath, 'utf8'))).toEqual(initial.value);
    expect((await store.read()).value).toEqual(value);

    const unchanged = await store.save(value, { expectedHash: saved.hash });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.backupPath).toBeNull();
  });

  it('refuses to overwrite an externally changed file', async () => {
    const store = await createStore();
    await store.ensure();
    await fs.writeFile(
      store.filePath,
      JSON.stringify({ servers: { external: { port: 31600 } } }),
      'utf8'
    );

    await expect(
      store.save(createDefaultServersConfig(), { expectedHash: 'outdated-hash' })
    ).rejects.toBeInstanceOf(ConfigConflictError);
  });

  it('preserves a concurrent edit made after the initial hash check but before commit', async () => {
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    let commitReached!: () => void;
    const reachedCommit = new Promise<void>(resolve => {
      commitReached = resolve;
    });
    const store = await createStore({
      beforeSaveCommit: async () => {
        commitReached();
        await commitReleased;
      },
    });
    const initial = await store.ensure();
    const externalBytes = Buffer.from(
      `${JSON.stringify({ servers: { external: { port: 31600 } } }, null, 2)}\n`,
      'utf8'
    );

    const save = store.save(
      { servers: { desktop: { port: 31500 } } },
      { expectedHash: initial.hash }
    );
    await reachedCommit;
    await fs.writeFile(store.filePath, externalBytes);
    releaseCommit();

    await expect(save).rejects.toBeInstanceOf(ConfigConflictError);
    expect(await fs.readFile(store.filePath)).toEqual(externalBytes);
  });

  it('serializes concurrent saves so the same stale hash cannot win twice', async () => {
    const store = await createStore();
    const initial = await store.ensure();
    const first = store.save(
      { servers: { first: { port: 31500 } } },
      {
        expectedHash: initial.hash,
      }
    );
    const second = store.save(
      { servers: { second: { port: 31600 } } },
      {
        expectedHash: initial.hash,
      }
    );

    await expect(first).resolves.toMatchObject({ changed: true });
    await expect(second).rejects.toBeInstanceOf(ConfigConflictError);
  });

  it('restores the exact prior file and reloads it when backend apply fails', async () => {
    const store = await createStore();
    const initial = await store.ensure();
    const before = await fs.readFile(store.filePath);
    const rollback = vi.fn(async (_previous: ServersConfig | null) => undefined);

    await expect(
      store.save(
        { servers: { forge: { port: 31500, connectionType: 'websocket' } } },
        {
          expectedHash: initial.hash,
          hooks: {
            apply: async () => {
              throw new Error('listener bind failed');
            },
            rollback,
          },
        }
      )
    ).rejects.toBeInstanceOf(ConfigApplyError);

    expect(await fs.readFile(store.filePath)).toEqual(before);
    expect(rollback).toHaveBeenCalledWith(initial.value);
  });

  it('does not overwrite a concurrent edit while rolling back a failed apply', async () => {
    const store = await createStore();
    const initial = await store.ensure();
    const externalBytes = Buffer.from(
      `${JSON.stringify({ servers: { external: { port: 31600 } } }, null, 2)}\n`,
      'utf8'
    );
    const rollback = vi.fn(async (_previous: ServersConfig | null) => undefined);

    let failure: unknown;
    try {
      await store.save(
        { servers: { forge: { port: 31500, connectionType: 'websocket' } } },
        {
          expectedHash: initial.hash,
          hooks: {
            apply: async () => {
              await fs.writeFile(store.filePath, externalBytes);
              throw new Error('listener bind failed');
            },
            rollback,
          },
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigApplyError);
    expect((failure as ConfigApplyError).rollbackError).toBeInstanceOf(ConfigConflictError);
    expect(await fs.readFile(store.filePath)).toEqual(externalBytes);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('refuses to treat a directory as the configuration file', async () => {
    const store = await createStore();
    await fs.mkdir(store.filePath);
    await expect(store.read()).rejects.toThrow(/non-regular configuration file/);
  });

  it('inspects and safely replaces malformed JSON while preserving an exact backup', async () => {
    const store = await createStore();
    const malformed = Buffer.from('{ "servers": { broken json\n', 'utf8');
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(store.filePath, malformed);
    const inspection = await store.inspect();
    expect(inspection).toMatchObject({ valid: false, exists: true });

    const saved = await store.save(createDefaultServersConfig(), {
      expectedHash: inspection.hash,
      allowInvalidPrevious: true,
    });
    expect(saved.changed).toBe(true);
    expect(await fs.readFile(store.backupPath)).toEqual(malformed);
    expect((await store.inspect()).valid).toBe(true);
  });
});
