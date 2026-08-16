import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  createDefaultServersConfig,
  validateServersConfig,
} from '../src/main/config-validation.js';

describe('server config validation', () => {
  it('normalizes the default configuration', () => {
    expect(validateServersConfig(createDefaultServersConfig())).toEqual({
      defaultServer: 'default',
      servers: {
        default: {
          label: 'Local Foundry VTT',
          host: 'localhost',
          port: 31415,
          connectionType: 'auto',
          remoteMode: false,
        },
      },
    });
  });

  it('rejects overlapping listener and WebRTC signaling ports', () => {
    expect(() =>
      validateServersConfig({
        servers: {
          first: { port: 31415, connectionType: 'auto' },
          second: { port: 31416, connectionType: 'websocket' },
        },
      })
    ).toThrow(/port 31416 conflicts/);
  });

  it('requires a strong shared secret for remote listeners', () => {
    expect(() =>
      validateServersConfig({
        servers: { forge: { remoteMode: true, authToken: 'short' } },
      })
    ).toThrow(ConfigValidationError);
    expect(() =>
      validateServersConfig({
        servers: { forge: { remoteMode: true, authToken: 'short' } },
      })
    ).toThrow(/at least 16 characters/);
  });

  it('rejects invalid profile bounds and empty server sets', () => {
    expect(() => validateServersConfig({ servers: {} })).toThrow(/at least one profile/);
    expect(() =>
      validateServersConfig({ servers: { bad: { port: 80, reconnectAttempts: 0 } } })
    ).toThrow(/integer from 1024 through 65535/);
  });

  it('rejects blank hosts and a default that is not a configured profile', () => {
    expect(() =>
      validateServersConfig({ defaultServer: 'missing', servers: { local: { host: '   ' } } })
    ).toThrow(/host cannot be blank/);
    expect(() =>
      validateServersConfig({ defaultServer: 'missing', servers: { local: {} } })
    ).toThrow(/must name an existing profile/);
  });
});
