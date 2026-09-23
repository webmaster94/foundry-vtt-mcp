import { describe, expect, it } from 'vitest';
import { beginQueryTiming, observeTool, type ToolObservation } from './query-timing.js';

describe('tool timing isolation', () => {
  it('attributes interleaved socket completions to their initiating tools', async () => {
    const observed: ToolObservation[] = [];
    const completions: (() => void)[] = [];
    const run = (tool: string, method: string) =>
      observeTool(
        tool,
        () =>
          new Promise(resolve => {
            const finish = beginQueryTiming(`foundry-mcp-bridge.${method}`);
            completions.push(() => {
              finish('success', 0);
              finish('error');
              resolve(tool);
            });
          }),
        event => observed.push(event)
      );
    const first = run('first', 'listActors');
    const second = run('second', 'createDocument');
    completions[1]();
    completions[0]();
    await Promise.all([first, second]);
    expect(observed.find(event => event.tool === 'first')?.queries).toEqual([
      expect.objectContaining({
        operation: 'foundry-mcp-bridge.listActors',
        safety: 'read',
        outcome: 'success',
        foundryExecutionMs: 0,
      }),
    ]);
    expect(observed.find(event => event.tool === 'second')?.queries[0]?.safety).toBe('write');
  });
  it('bounds multi-query traces and ignores invalid module clocks', async () => {
    let observed: ToolObservation | undefined;
    await observeTool(
      'batch',
      async () => {
        for (let i = 0; i < 70; i++)
          beginQueryTiming('foundry-mcp-bridge.listActors')('success', Infinity);
      },
      value => {
        observed = value;
      }
    );
    expect(observed?.queries).toHaveLength(64);
    expect(observed?.omittedQueries).toBe(6);
    expect(observed?.queries[0]).not.toHaveProperty('foundryExecutionMs');
  });
  it('keeps the original outcome when the observer fails', async () => {
    const observe = () => {
      throw new Error('observer failed');
    };
    await expect(observeTool('read', async () => 42, observe)).resolves.toBe(42);
    const error = new Error('original failure');
    await expect(
      observeTool(
        'write',
        async () => {
          throw error;
        },
        observe
      )
    ).rejects.toBe(error);
  });
});
