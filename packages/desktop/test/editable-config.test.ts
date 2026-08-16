import { describe, expect, it } from 'vitest';
import {
  maskServersConfig,
  materializeServersConfig,
  redactedJsonPreview,
} from '../src/main/editable-config.js';
import { ServersConfig } from '../src/shared/contracts.js';

const stored: ServersConfig = {
  defaultServer: 'forge',
  servers: {
    forge: {
      label: 'Forge',
      port: 31415,
      remoteMode: true,
      authToken: 'super-secret-token-value',
    },
  },
};

describe('editable connection config boundary', () => {
  it('masks auth tokens before data crosses into the renderer', () => {
    const masked = maskServersConfig(stored);
    expect(masked.servers.forge).toMatchObject({ authTokenConfigured: true });
    expect(JSON.stringify(masked)).not.toContain('super-secret-token-value');
    expect(redactedJsonPreview(masked)).toContain('<configured — hidden>');
    expect(redactedJsonPreview(masked)).not.toContain('super-secret-token-value');
  });

  it('keeps, replaces, and clears secrets only through explicit operations', () => {
    const masked = maskServersConfig(stored);
    expect(materializeServersConfig(masked, stored, { forge: { mode: 'keep' } })).toMatchObject({
      servers: { forge: { authToken: 'super-secret-token-value' } },
    });
    expect(
      materializeServersConfig(masked, stored, {
        forge: { mode: 'replace', value: 'replacement-token-value' },
      })
    ).toMatchObject({ servers: { forge: { authToken: 'replacement-token-value' } } });
    expect(materializeServersConfig(masked, stored, { forge: { mode: 'clear' } })).toEqual({
      defaultServer: 'forge',
      servers: { forge: { label: 'Forge', port: 31415, remoteMode: true } },
    });
  });

  it('never carries a hidden secret to a duplicated or renamed profile', () => {
    const duplicate = {
      defaultServer: 'forge-copy',
      servers: {
        'forge-copy': {
          ...maskServersConfig(stored).servers.forge,
          authTokenConfigured: true,
          authToken: 'renderer-injected-secret',
        },
      },
    };
    const materialized = materializeServersConfig(duplicate, stored, {
      'forge-copy': { mode: 'keep' },
    });

    expect(JSON.stringify(materialized)).not.toContain('super-secret-token-value');
    expect(JSON.stringify(materialized)).not.toContain('renderer-injected-secret');
    expect(materialized).toMatchObject({ servers: { 'forge-copy': { label: 'Forge' } } });
  });
});
