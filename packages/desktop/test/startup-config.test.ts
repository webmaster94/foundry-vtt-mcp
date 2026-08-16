import { describe, expect, it, vi } from 'vitest';
import { initializeConfigSafely } from '../src/main/startup-config.js';

describe('desktop config startup', () => {
  it('reports malformed config without aborting application startup', async () => {
    const ensure = vi.fn(async () => {
      throw new Error('Server configuration is not valid JSON');
    });

    await expect(initializeConfigSafely({ ensure })).resolves.toEqual({
      ok: false,
      error: 'Server configuration is not valid JSON',
    });
  });

  it('reports a valid or newly created config as ready', async () => {
    await expect(
      initializeConfigSafely({ ensure: vi.fn(async () => ({ exists: true })) })
    ).resolves.toEqual({ ok: true });
  });
});
