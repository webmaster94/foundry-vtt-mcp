import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendControl, BackendSupervisor } from '../src/main/backend-supervisor.js';
import { BackendStatusResult } from '../src/shared/contracts.js';

const statusResult: BackendStatusResult = {
  protocolVersion: 1,
  backend: {
    pid: 12,
    version: '0.12.0',
    startedAt: 'now',
    entrySig: 'sig',
    instanceId: 'managed-instance',
  },
  config: { path: 'foundry-servers.json', exists: true, source: 'file' },
  activeServer: 'default',
  servers: [],
};

function control(overrides: Partial<BackendControl> = {}): BackendControl {
  return {
    ping: vi.fn(async () => ({ ok: true as const, ...statusResult.backend })),
    getStatus: vi.fn(async () => statusResult),
    shutdown: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('BackendSupervisor', () => {
  it('adopts an existing daemon without spawning another copy', async () => {
    const backendControl = control();
    const spawnBackend = vi.fn(async () => undefined);
    const supervisor = new BackendSupervisor({ control: backendControl, spawnBackend });
    const updates = vi.fn();
    supervisor.subscribe(updates);

    const status = await supervisor.ensureRunning();
    supervisor.stopMonitoring();
    expect(status.state).toBe('online');
    expect(spawnBackend).not.toHaveBeenCalled();
    expect(updates).toHaveBeenCalled();
  });

  it('serializes concurrent startup attempts and waits for the spawned daemon', async () => {
    let pingCount = 0;
    const backendControl = control({
      ping: vi.fn(async () => {
        pingCount += 1;
        if (pingCount === 1) throw new Error('ECONNREFUSED');
        return { ok: true as const, ...statusResult.backend };
      }),
    });
    const spawnBackend = vi.fn(async () => ({ pid: 99 }));
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend,
      wait: async () => undefined,
      startupTimeoutMs: 1_000,
    });

    const [first, second] = await Promise.all([
      supervisor.ensureRunning(),
      supervisor.ensureRunning(),
    ]);
    supervisor.stopMonitoring();
    expect(first.state).toBe('online');
    expect(second.state).toBe('online');
    expect(spawnBackend).toHaveBeenCalledOnce();
  });

  it('stops monitoring and treats a disconnected shutdown as success', async () => {
    let stopping = false;
    const shutdown = vi.fn(async () => {
      stopping = true;
      return { ok: true };
    });
    const backendControl = control({
      shutdown,
      ping: vi.fn(async () => {
        if (stopping) throw new Error('ECONNREFUSED');
        return { ok: true as const, ...statusResult.backend };
      }),
    });
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend: async () => undefined,
      wait: async () => undefined,
    });

    await supervisor.ensureRunning();
    await supervisor.shutdown();
    expect(supervisor.getStatus()).toMatchObject({ state: 'offline', status: null });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('leaves a foreign replacement untouched during desktop exit or update shutdown', async () => {
    let instanceId = 'managed-instance';
    const shutdown = vi.fn(async () => ({ ok: true }));
    const backendControl = control({
      ping: vi.fn(async () => ({
        ok: true as const,
        ...statusResult.backend,
        instanceId,
      })),
      getStatus: vi.fn(async () => ({
        ...statusResult,
        backend: { ...statusResult.backend, instanceId },
      })),
      shutdown,
    });
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend: async () => undefined,
      wait: async () => undefined,
    });
    await supervisor.ensureRunning();

    instanceId = 'foreign-replacement';
    await supervisor.shutdown();

    expect(shutdown).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toMatchObject({
      state: 'offline',
      status: null,
      message: expect.stringContaining('left untouched'),
    });
  });

  it('finishes shutdown when the requested managed instance is replaced', async () => {
    let instanceId = 'managed-instance';
    const shutdown = vi.fn(async () => {
      instanceId = 'replacement-instance';
      return { ok: true };
    });
    const backendControl = control({
      ping: vi.fn(async () => ({
        ok: true as const,
        ...statusResult.backend,
        instanceId,
      })),
      getStatus: vi.fn(async () => ({
        ...statusResult,
        backend: { ...statusResult.backend, instanceId },
      })),
      shutdown,
    });
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend: async () => undefined,
      wait: async () => undefined,
    });
    await supervisor.ensureRunning();

    await supervisor.shutdown();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(supervisor.getStatus()).toMatchObject({ state: 'offline', status: null });
  });

  it('automatically respawns a daemon that crashes while the tray app remains active', async () => {
    vi.useFakeTimers();
    let crashed = false;
    let spawned = false;
    const backendControl = control({
      ping: vi.fn(async () => {
        if (crashed && !spawned) throw new Error('ECONNREFUSED');
        return { ok: true as const, ...statusResult.backend };
      }),
      getStatus: vi.fn(async () => {
        if (crashed && !spawned) throw new Error('ECONNREFUSED');
        return statusResult;
      }),
    });
    const spawnBackend = vi.fn(async () => {
      spawned = true;
      crashed = false;
      return { pid: 100 };
    });
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend,
      wait: async () => undefined,
      monitorIntervalMs: 50,
    });
    await supervisor.ensureRunning();

    crashed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnBackend).toHaveBeenCalledOnce();
    expect(supervisor.getStatus().state).toBe('online');
    supervisor.stopMonitoring();
  });

  it('gracefully replaces a daemon that owns a different config file', async () => {
    let phase: 'old' | 'stopped' | 'new' = 'old';
    const shutdown = vi.fn(async () => {
      phase = 'stopped';
      return { ok: true };
    });
    const backendControl = control({
      ping: vi.fn(async () => {
        if (phase === 'stopped') throw new Error('ECONNREFUSED');
        return { ok: true as const, ...statusResult.backend };
      }),
      getStatus: vi.fn(async () => ({
        ...statusResult,
        config: {
          path: phase === 'old' ? 'other-config.json' : 'canonical-config.json',
          exists: true,
          source: 'environment' as const,
        },
      })),
      shutdown,
    });
    const spawnBackend = vi.fn(async () => {
      phase = 'new';
      return { pid: 101 };
    });
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend,
      wait: async () => undefined,
      acceptBackendStatus: status => status.config.path === 'canonical-config.json',
    });

    const result = await supervisor.ensureRunning();
    supervisor.stopMonitoring();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(spawnBackend).toHaveBeenCalledOnce();
    expect(result.state).toBe('online');
  });

  it('detects and replaces a different backend identity during monitoring', async () => {
    vi.useFakeTimers();
    let phase: 'managed' | 'replaced' | 'stopped' = 'managed';
    const shutdown = vi.fn(async () => {
      phase = 'stopped';
      return { ok: true };
    });
    const identity = () => ({
      ...statusResult.backend,
      pid: phase === 'replaced' ? 999 : 12,
    });
    const backendControl = control({
      ping: vi.fn(async () => {
        if (phase === 'stopped') throw new Error('ECONNREFUSED');
        return { ok: true as const, ...identity() };
      }),
      getStatus: vi.fn(async () => {
        if (phase === 'stopped') throw new Error('ECONNREFUSED');
        return { ...statusResult, backend: identity() };
      }),
      shutdown,
    });
    const spawnBackend = vi.fn(async () => {
      phase = 'managed';
      return { pid: 12 };
    });
    const supervisor = new BackendSupervisor({
      control: backendControl,
      spawnBackend,
      wait: async () => undefined,
      monitorIntervalMs: 50,
      acceptBackendIdentity: backend => backend.pid === 12,
      acceptBackendStatus: status => status.backend.pid === 12,
    });
    await supervisor.ensureRunning();

    phase = 'replaced';
    await vi.advanceTimersByTimeAsync(100);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(spawnBackend).toHaveBeenCalledOnce();
    expect(supervisor.getStatus().state).toBe('online');
    supervisor.stopMonitoring();
  });
});
