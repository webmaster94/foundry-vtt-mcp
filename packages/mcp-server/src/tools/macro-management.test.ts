import { describe, expect, it, vi } from 'vitest';
import { MacroManagementTools } from './macro-management.js';

function createTools() {
  const query = vi.fn().mockResolvedValue({ success: true });
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
  };
  const tools = new MacroManagementTools({
    foundryClient: { query } as any,
    logger: logger as any,
  });
  return { tools, query };
}

describe('MacroManagementTools', () => {
  it('exposes macro management tools', () => {
    const { tools } = createTools();

    expect(tools.getToolDefinitions().map((tool) => tool.name)).toEqual([
      'list-macros',
      'get-macro',
      'create-macro',
      'update-macro',
      'delete-macro',
      'execute-macro',
    ]);
  });

  it('creates macros through generic document creation', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('create-macro', { name: 'Test Macro', type: 'script', command: 'return 1;' });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.createDocument', {
      documentType: 'Macro',
      data: {
        name: 'Test Macro',
        type: 'script',
        command: 'return 1;',
      },
    });
  });

  it('executes macros through the executeMacro query', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('execute-macro', { name: 'Test Macro' });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.executeMacro', { name: 'Test Macro' });
  });
});
