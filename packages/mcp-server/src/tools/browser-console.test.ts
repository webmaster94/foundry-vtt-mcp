import { describe, expect, it, vi } from 'vitest';
import { BrowserConsoleTools } from './browser-console.js';

function createTools() {
  const query = vi.fn().mockResolvedValue({ success: true });
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
  };

  const tools = new BrowserConsoleTools({
    foundryClient: { query } as any,
    logger: logger as any,
  });

  return { tools, query };
}

describe('BrowserConsoleTools', () => {
  it('exposes browser console MCP tool definitions', () => {
    const { tools } = createTools();
    const definitions = tools.getToolDefinitions();

    expect(definitions.map((tool) => tool.name)).toEqual([
      'get-browser-console',
      'clear-browser-console',
      'get-browser-console-status',
    ]);
  });

  it('validates get-browser-console input and forwards defaults', async () => {
    const { tools, query } = createTools();

    await tools.handleGetBrowserConsole({ levels: ['info', 'error'], sinceId: 7 });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getBrowserConsole', {
      levels: ['info', 'error'],
      sinceId: 7,
      limit: 100,
      includeStack: true,
      includeRawArgs: false,
    });
  });

  it('requires confirmation before clearing the console buffer', async () => {
    const { tools, query } = createTools();

    await expect(tools.handleClearBrowserConsole({ confirmClear: false })).rejects.toThrow(
      'clear-browser-console requires confirmClear=true'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('forwards confirmed clear requests', async () => {
    const { tools, query } = createTools();

    await tools.handleClearBrowserConsole({ confirmClear: true });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.clearBrowserConsole', { confirmClear: true });
  });
});
