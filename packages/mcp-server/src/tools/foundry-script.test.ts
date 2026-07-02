import { describe, expect, it, vi } from 'vitest';
import { FoundryScriptTools } from './foundry-script.js';

function createTools() {
  const query = vi.fn().mockResolvedValue({ success: true });
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
  };
  const tools = new FoundryScriptTools({
    foundryClient: { query } as any,
    logger: logger as any,
  });
  return { tools, query };
}

describe('FoundryScriptTools', () => {
  it('forwards browser script execution with defaults', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('execute-foundry-script', { code: 'return game.world.title;' });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.executeFoundryScript', {
      code: 'return game.world.title;',
      mode: 'script',
      timeoutMs: 5000,
      resultLimitBytes: 256000,
    });
  });

  it('forwards safe query explorer requests', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('query-foundry-data', { root: 'game.actors', fields: ['name'], limit: 3 });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.queryFoundryData', expect.objectContaining({
      root: 'game.actors',
      fields: ['name'],
      limit: 3,
      includeSystem: true,
      includeFlags: false,
    }));
  });

  it('requires confirmation before clearing audit logs', async () => {
    const { tools } = createTools();

    await expect(tools.handleToolCall('clear-mcp-audit-log', { confirmClear: false })).rejects.toThrow(
      'clear-mcp-audit-log requires confirmClear=true'
    );
  });
});
