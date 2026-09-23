import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { createToolObserver } from './tool-observer.js';
import { observeTool } from './query-timing.js';

describe('optional timing diagnostics', () => {
  it('is disabled unless timing is explicitly selected', () => {
    const logger = { info: vi.fn() } as unknown as Logger;
    expect(createToolObserver({}, logger)).toBeUndefined();
    expect(createToolObserver({ FOUNDRY_DIAGNOSTICS: 'shadow' }, logger)).toBeUndefined();
  });
  it('records timings without changing the result', async () => {
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    const observer = createToolObserver({ FOUNDRY_DIAGNOSTICS: 'timing' }, logger)!;
    await expect(observeTool('get-document', async () => 42, observer)).resolves.toBe(42);
    expect(info).toHaveBeenCalledWith(
      'Game API timing',
      expect.objectContaining({ tool: 'get-document', outcome: 'success' })
    );
  });
});
