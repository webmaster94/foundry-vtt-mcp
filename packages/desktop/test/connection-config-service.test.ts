import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveAndApplyConnections } from '../src/main/connection-config-service.js';
import { BackendControlClient } from '../src/main/control-client.js';
import { ConfigApplyError, ConfigStore } from '../src/main/config-store.js';
import {
  createDefaultServersConfig,
  validateServersConfig,
} from '../src/main/config-validation.js';
import { maskServersConfig } from '../src/main/editable-config.js';
import type {
  BackendStatusResult,
  DesktopStatus,
  SaveConnectionsRequest,
  ServersConfig,
} from '../src/shared/contracts.js';

interface RpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

const roots: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<ConfigStore<ServersConfig>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-mcp-config-apply-'));
  roots.push(root);
  const store = new ConfigStore<ServersConfig>(
    path.join(root, 'foundry-servers.json'),
    validateServersConfig,
    createDefaultServersConfig
  );
  await store.ensure();
  return store;
}

function backendStatus(configPath: string): BackendStatusResult {
  return {
    protocolVersion: 1,
    backend: {
      pid: 42,
      version: '0.12.0',
      startedAt: 'now',
      entrySig: 'sig',
      entryPath: 'backend.bundle.cjs',
    },
    config: { path: configPath, exists: true, source: 'environment' },
    activeServer: 'default',
    servers: [],
  };
}

function desktopStatus(status: BackendStatusResult): DesktopStatus {
  return {
    state: 'online',
    checkedAt: new Date().toISOString(),
    status,
  };
}

function requestFor(value: ReturnType<typeof maskServersConfig>, hash: string | null) {
  return {
    value,
    expectedHash: hash,
    authTokenUpdates: Object.fromEntries(
      Object.keys(value.servers).map(name => [name, { mode: 'clear' as const }])
    ),
    replaceInvalid: false,
  } satisfies SaveConnectionsRequest;
}

async function startControlServer(
  handler: (request: RpcRequest) => Promise<{ result?: unknown; error?: { message: string } }>
): Promise<number> {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      void (async () => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as RpcRequest;
        const response = await handler(request);
        socket.end(`${JSON.stringify({ id: request.id, ...response })}\n`);
      })().catch(error => {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Control fixture did not bind');
  return address.port;
}

function reloadResult() {
  return {
    added: [],
    removed: [],
    changed: [],
    unchanged: ['default'],
    activeServer: 'default',
    servers: [],
  };
}

describe('connection config live application', () => {
  it('writes first, reloads through a live control endpoint, and confirms the managed backend', async () => {
    const store = await createStore();
    const initial = await store.read();
    const status = backendStatus(store.filePath);
    const methods: string[] = [];
    let labelSeenDuringReload = '';
    const port = await startControlServer(async request => {
      methods.push(request.method);
      if (request.method === 'get_status') return { result: status };
      if (request.method === 'reload_servers_config') {
        labelSeenDuringReload = JSON.parse(await fs.readFile(store.filePath, 'utf8')).servers
          .default.label;
        return { result: reloadResult() };
      }
      return { error: { message: `Unknown method: ${request.method}` } };
    });
    const control = new BackendControlClient({ port, requestTimeoutMs: 1_000 });
    const value = maskServersConfig(initial.value);
    value.servers.default.label = 'Updated listener';
    const supervisor = {
      ensureRunning: vi.fn(async () => desktopStatus(status)),
      refresh: vi.fn(async () => desktopStatus(status)),
    };

    const result = await saveAndApplyConnections(requestFor(value, initial.hash), {
      configStore: store,
      control,
      supervisor,
      matchesManagedBackend: candidate => candidate.config.path === store.filePath,
    });

    expect(result).toMatchObject({ changed: true, applied: true });
    expect(labelSeenDuringReload).toBe('Updated listener');
    expect(methods).toEqual(['get_status', 'get_status', 'reload_servers_config']);
    expect(supervisor.ensureRunning).not.toHaveBeenCalled();
    expect(supervisor.refresh).toHaveBeenCalledOnce();
  });

  it('reloads unchanged bytes because Save and reload is an explicit live action', async () => {
    const store = await createStore();
    const initial = await store.read();
    const status = backendStatus(store.filePath);
    const methods: string[] = [];
    const port = await startControlServer(async request => {
      methods.push(request.method);
      return request.method === 'get_status' ? { result: status } : { result: reloadResult() };
    });
    const control = new BackendControlClient({ port, requestTimeoutMs: 1_000 });

    const result = await saveAndApplyConnections(
      requestFor(maskServersConfig(initial.value), initial.hash),
      {
        configStore: store,
        control,
        supervisor: {
          ensureRunning: vi.fn(async () => desktopStatus(status)),
          refresh: vi.fn(async () => desktopStatus(status)),
        },
        matchesManagedBackend: candidate => candidate.config.path === store.filePath,
      }
    );

    expect(result).toMatchObject({ changed: false, applied: true });
    expect(methods).toEqual(['get_status', 'get_status', 'reload_servers_config']);
  });

  it('starts an offline managed backend only after writing, then commits after reload', async () => {
    const store = await createStore();
    const initial = await store.read();
    const status = backendStatus(store.filePath);
    const methods: string[] = [];
    let started = false;
    let labelSeenDuringStart = '';
    let labelSeenDuringReload = '';
    const port = await startControlServer(async request => {
      methods.push(request.method);
      if (request.method === 'get_status') {
        return started ? { result: status } : { error: { message: 'ECONNREFUSED' } };
      }
      labelSeenDuringReload = JSON.parse(await fs.readFile(store.filePath, 'utf8')).servers.default
        .label;
      return { result: reloadResult() };
    });
    const control = new BackendControlClient({ port, requestTimeoutMs: 1_000 });
    const value = maskServersConfig(initial.value);
    value.servers.default.label = 'Started listener';
    const supervisor = {
      ensureRunning: vi.fn(async () => {
        labelSeenDuringStart = JSON.parse(await fs.readFile(store.filePath, 'utf8')).servers.default
          .label;
        started = true;
        return desktopStatus(status);
      }),
      refresh: vi.fn(async () => desktopStatus(status)),
    };

    const result = await saveAndApplyConnections(requestFor(value, initial.hash), {
      configStore: store,
      control,
      supervisor,
      matchesManagedBackend: candidate => candidate.config.path === store.filePath,
    });

    expect(result).toMatchObject({ changed: true, applied: true });
    expect(labelSeenDuringStart).toBe('Started listener');
    expect(labelSeenDuringReload).toBe('Started listener');
    expect(methods).toEqual(['get_status', 'get_status', 'reload_servers_config']);
    expect(supervisor.ensureRunning).toHaveBeenCalledOnce();
    expect(supervisor.refresh).toHaveBeenCalledOnce();
  });

  it('restores the prior file and live registry when a changed listener cannot apply', async () => {
    const store = await createStore();
    const initial = await store.read();
    const priorBytes = await fs.readFile(store.filePath);
    const status = backendStatus(store.filePath);
    let reloadCount = 0;
    const port = await startControlServer(async request => {
      if (request.method === 'get_status') return { result: status };
      reloadCount += 1;
      return reloadCount === 1
        ? { error: { message: 'listener bind failed' } }
        : { result: reloadResult() };
    });
    const control = new BackendControlClient({ port, requestTimeoutMs: 1_000 });
    const value = maskServersConfig(initial.value);
    value.servers.default.port = 31500;

    await expect(
      saveAndApplyConnections(requestFor(value, initial.hash), {
        configStore: store,
        control,
        supervisor: {
          ensureRunning: vi.fn(async () => desktopStatus(status)),
          refresh: vi.fn(async () => desktopStatus(status)),
        },
        matchesManagedBackend: candidate => candidate.config.path === store.filePath,
      })
    ).rejects.toBeInstanceOf(ConfigApplyError);

    expect(await fs.readFile(store.filePath)).toEqual(priorBytes);
    expect(reloadCount).toBe(2);
  });

  it('restores offline changes when no managed backend can start', async () => {
    const store = await createStore();
    const initial = await store.read();
    const priorBytes = await fs.readFile(store.filePath);
    const value = maskServersConfig(initial.value);
    value.servers.default.label = 'Must roll back';
    const control = {
      getStatus: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      reloadServersConfig: vi.fn(async () => reloadResult()),
    };

    const ensureRunning = vi.fn(async () => ({
      state: 'error' as const,
      checkedAt: new Date().toISOString(),
      status: null,
      message: 'Backend runtime is unavailable',
    }));

    const operation = saveAndApplyConnections(requestFor(value, initial.hash), {
      configStore: store,
      control,
      supervisor: {
        ensureRunning,
        refresh: vi.fn(async () => ({
          state: 'offline' as const,
          checkedAt: new Date().toISOString(),
          status: null,
        })),
      },
      matchesManagedBackend: () => false,
    });

    await expect(operation).rejects.toMatchObject({
      name: 'ConfigApplyError',
      message: expect.stringContaining('rollback also failed'),
      applyError: expect.objectContaining({ message: 'Backend runtime is unavailable' }),
      rollbackError: expect.objectContaining({ message: 'Backend runtime is unavailable' }),
    } satisfies Partial<ConfigApplyError>);
    expect(await fs.readFile(store.filePath)).toEqual(priorBytes);
    expect(await fs.readFile(store.backupPath)).toEqual(priorBytes);
    expect(ensureRunning).toHaveBeenCalledTimes(2);
    expect(control.getStatus).toHaveBeenCalledTimes(2);
    expect(control.reloadServersConfig).not.toHaveBeenCalled();
  });
});
