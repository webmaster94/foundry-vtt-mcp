import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../foundry-client.js';
import { detectGameSystem, detectGameSystemInfo } from './system-detection.js';

function clientWithQuery(query: ReturnType<typeof vi.fn>): FoundryClient {
  return { query } as unknown as FoundryClient;
}

describe('system detection', () => {
  it('detects a string worldInfo.system value', async () => {
    const query = vi.fn().mockResolvedValue({ system: 'mgt2e' });

    await expect(detectGameSystem(clientWithQuery(query))).resolves.toBe('mgt2e');
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getWorldInfo');
  });

  it('detects a Foundry v13 object worldInfo.system value case-insensitively', async () => {
    const query = vi.fn().mockResolvedValue({
      system: { id: 'MGT2E', title: 'Mongoose Traveller 2e', version: '7.0.0' },
    });

    await expect(detectGameSystemInfo(clientWithQuery(query))).resolves.toEqual({
      system: 'mgt2e',
      systemId: 'mgt2e',
    });
  });

  it('retries after a transient detection failure', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('world is reconnecting'))
      .mockResolvedValueOnce({ system: 'dnd5e' });
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn } as any;
    const client = clientWithQuery(query);

    await expect(detectGameSystem(client, logger)).resolves.toBe('other');
    await expect(detectGameSystem(client, logger)).resolves.toBe('dnd5e');
    expect(query).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not leak detection between named routed profiles', async () => {
    let activeProfile = 'traveller';
    const query = vi.fn(async () => ({
      system: activeProfile === 'traveller' ? 'mgt2e' : { id: 'pf2e' },
    }));
    const client = clientWithQuery(query);

    await expect(detectGameSystem(client)).resolves.toBe('mgt2e');
    activeProfile = 'pathfinder';
    await expect(detectGameSystem(client)).resolves.toBe('pf2e');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves an unsupported raw system ID while normalizing to other', async () => {
    const query = vi.fn().mockResolvedValue({ system: { id: 'coc7' } });

    await expect(detectGameSystemInfo(clientWithQuery(query))).resolves.toEqual({
      system: 'other',
      systemId: 'coc7',
    });
  });
});
