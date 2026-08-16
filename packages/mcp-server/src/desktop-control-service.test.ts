import { describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import { DesktopControlService, isDesktopControlMethod } from './desktop-control-service.js';
import type { Logger } from './logger.js';
import type { ServerRegistry } from './server-registry.js';

function fixture() {
  let active = 'local';
  const registry = {
    getStatus: vi.fn(() => ({
      config: { path: 'C:/config/foundry-servers.json', exists: true, source: 'file' as const },
      activeServer: active,
      servers: [
        {
          name: 'local',
          label: 'Local',
          host: 'localhost',
          port: 31415,
          connectionType: 'websocket',
          remoteMode: false,
          active: true,
          connected: true,
          connectionInfo: { started: true, connected: true },
          cachedCapabilities: null,
        },
      ],
    })),
    getActiveName: vi.fn(() => active),
    setActive: vi.fn((name: string) => {
      active = name;
      return { name };
    }),
    reconnect: vi.fn(async (name: string) => ({ name })),
    reloadConfig: vi.fn(async () => ({
      added: ['forge'],
      removed: [],
      changed: [],
      unchanged: ['local'],
    })),
    list: vi.fn(() => [
      { name: 'local', port: 31415, connected: true },
      { name: 'forge', port: 31419, connected: false },
    ]),
  };
  const logger = {} as Logger;
  const service = new DesktopControlService(
    registry as unknown as ServerRegistry,
    config,
    logger,
    () => ({
      ok: true,
      pid: 42,
      version: '0.12.0',
      startedAt: '2026-01-01T00:00:00.000Z',
      entrySig: '100:200',
      instanceId: 'instance-a',
      entryPath: 'C:/app/backend.js',
    })
  );
  return { service, registry, logger };
}

describe('DesktopControlService', () => {
  it('recognizes only the narrow desktop control method allowlist', () => {
    expect(isDesktopControlMethod('get_status')).toBe(true);
    expect(isDesktopControlMethod('reload_servers_config')).toBe(true);
    expect(isDesktopControlMethod('call_tool')).toBe(false);
    expect(isDesktopControlMethod('shutdown')).toBe(false);
  });

  it('returns status synchronously from cached registry state with no secret fields', async () => {
    const { service, registry } = fixture();
    const result = await service.handle('get_status', {});

    expect(registry.getStatus).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      protocolVersion: 1,
      backend: { pid: 42, instanceId: 'instance-a' },
      config: { path: 'C:/config/foundry-servers.json', exists: true },
      activeServer: 'local',
      servers: [{ name: 'local', connected: true }],
    });
    expect(JSON.stringify(result)).not.toContain('authToken');
  });

  it('sets the active profile after trimming and rejects an empty name', async () => {
    const { service, registry } = fixture();

    await expect(service.handle('set_active_server', { name: '  forge  ' })).resolves.toEqual({
      activeServer: 'forge',
    });
    expect(registry.setActive).toHaveBeenCalledWith('forge');
    await expect(service.handle('set_active_server', { name: '   ' })).rejects.toThrow(
      'requires a non-empty name'
    );
  });

  it('reconnects an explicit profile or defaults to the active profile', async () => {
    const { service, registry } = fixture();

    await expect(service.handle('reconnect_server', { name: ' forge ' })).resolves.toEqual({
      server: 'forge',
      restarted: true,
    });
    await expect(service.handle('reconnect_server', {})).resolves.toEqual({
      server: 'local',
      restarted: true,
    });
    expect(registry.reconnect).toHaveBeenNthCalledWith(1, 'forge');
    expect(registry.reconnect).toHaveBeenNthCalledWith(2, 'local');
  });

  it('delegates reload to the serialized transactional registry and returns its live summary', async () => {
    const { service, registry, logger } = fixture();

    await expect(service.handle('reload_servers_config', {})).resolves.toEqual({
      added: ['forge'],
      removed: [],
      changed: [],
      unchanged: ['local'],
      activeServer: 'local',
      servers: [
        { name: 'local', port: 31415, connected: true },
        { name: 'forge', port: 31419, connected: false },
      ],
    });
    expect(registry.reloadConfig).toHaveBeenCalledWith(config, logger);
  });
});
