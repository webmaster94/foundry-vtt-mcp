import { describe, expect, it } from 'vitest';
import { countListenerFailures, getListenerFailure } from '../src/shared/connection-health.js';
import type { BackendConnectionStatus, BackendStatusResult } from '../src/shared/contracts.js';

const connection: BackendConnectionStatus = {
  name: 'local',
  label: 'Local',
  host: 'localhost',
  port: 31415,
  connectionType: 'auto',
  remoteMode: false,
  active: true,
  connected: false,
  connectionInfo: null,
  cachedCapabilities: null,
};

describe('connection listener health', () => {
  it('extracts a bounded listener error without trusting arbitrary connection info', () => {
    const failed = {
      ...connection,
      connectionInfo: {
        listener: {
          lastError: { message: `  ${'x'.repeat(700)}  `, at: 1234 },
        },
      },
    };

    expect(getListenerFailure(failed)).toEqual({ message: 'x'.repeat(500), at: 1234 });
    expect(
      getListenerFailure({ ...connection, connectionInfo: { listener: { lastError: {} } } })
    ).toBeNull();
  });

  it('counts failed profiles for tray severity', () => {
    const status: BackendStatusResult = {
      protocolVersion: 1,
      backend: { pid: 1, startedAt: 'now', entrySig: 'sig' },
      config: { path: 'config.json', exists: true, source: 'file' },
      activeServer: 'local',
      servers: [
        connection,
        {
          ...connection,
          name: 'broken',
          connectionInfo: {
            listener: { lastError: { message: 'EADDRINUSE', at: Date.now() } },
          },
        },
      ],
    };

    expect(countListenerFailures(status)).toBe(1);
  });
});
