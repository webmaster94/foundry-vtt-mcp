import { describe, expect, it, vi } from 'vitest';
import { DocumentManagementTools } from './document-management.js';

function createTools() {
  const query = vi.fn().mockResolvedValue({ success: true });
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
  };
  const tools = new DocumentManagementTools({
    foundryClient: { query } as any,
    logger: logger as any,
  });
  return { tools, query };
}

describe('DocumentManagementTools', () => {
  it('exposes generic and workflow document tools', () => {
    const { tools } = createTools();
    const names = tools.getToolDefinitions().map((tool) => tool.name);

    expect(names).toContain('list-document-types');
    expect(names).toContain('create-document');
    expect(names).toContain('list-world-items');
    expect(names).toContain('roll-roll-table');
    expect(names).toContain('create-scene-embedded-document');
  });

  it('validates and forwards generic list-documents calls', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('list-documents', { documentType: 'Macro', limit: 5 });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.listDocuments', expect.objectContaining({
      documentType: 'Macro',
      limit: 5,
      includeSystem: true,
      includeFlags: false,
    }));
  });

  it('routes workflow creation through generic document creation', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('create-world-item', { name: 'Test Item', type: 'loot' });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.createDocument', {
      documentType: 'Item',
      data: { name: 'Test Item', type: 'loot' },
      confirmBulkOperation: false,
    });
  });

  it('requires deletion confirmation for chat message bulk delete', async () => {
    const { tools } = createTools();

    await expect(tools.handleToolCall('delete-chat-messages', { ids: ['a'] })).rejects.toThrow(
      'delete-chat-messages requires confirmDeletion=true'
    );
  });
});
