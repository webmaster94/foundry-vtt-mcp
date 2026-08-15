import { describe, expect, it, vi } from 'vitest';
import { DocumentManagementTools } from './document-management.js';
import { SystemRegistry } from '../systems/system-registry.js';
import { MGT2eAdapter } from '../systems/mgt2e/adapter.js';

function createTools(options: { withMgt2e?: boolean } = {}) {
  const query = vi.fn().mockResolvedValue({ success: true });
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const systemRegistry = new SystemRegistry();
  if (options.withMgt2e) systemRegistry.register(new MGT2eAdapter());
  const tools = new DocumentManagementTools({
    foundryClient: { query } as any,
    logger: logger as any,
    ...(options.withMgt2e ? { systemRegistry } : {}),
  });
  return { tools, query };
}

describe('DocumentManagementTools', () => {
  it('exposes generic and workflow document tools', () => {
    const { tools } = createTools();
    const names = tools.getToolDefinitions().map(tool => tool.name);

    expect(names).toContain('list-document-types');
    expect(names).toContain('create-document');
    expect(names).toContain('roll-roll-table');
    expect(names).toContain('undo-last-mcp-operation');
    // context budget: per-type CRUD wrappers are dispatch-only, not advertised
    expect(names).not.toContain('list-world-items');
    expect(names).not.toContain('create-scene-embedded-document');
  });

  it('validates and forwards generic list-documents calls', async () => {
    const { tools, query } = createTools();

    await tools.handleToolCall('list-documents', { documentType: 'Macro', limit: 5 });

    expect(query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.listDocuments',
      expect.objectContaining({
        documentType: 'Macro',
        limit: 5,
        includeSystem: true,
        includeFlags: false,
      })
    );
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

  it('normalizes MGT2e actor creation through the audited generic handler', async () => {
    const { tools, query } = createTools({ withMgt2e: true });
    query.mockImplementation(async method =>
      method === 'foundry-mcp-bridge.getWorldInfo' ? { system: { id: 'mgt2e' } } : { success: true }
    );

    await tools.handleToolCall('create-document', {
      documentType: 'Actor',
      data: {
        name: 'Rae',
        type: 'traveller',
        system: {
          characteristics: { str: 8, dex: 9, end: 7 },
          skills: { Pilot: 2, admin: 1 },
        },
      },
    });

    expect(query).toHaveBeenLastCalledWith(
      'foundry-mcp-bridge.createDocument',
      expect.objectContaining({
        documentType: 'Actor',
        data: expect.objectContaining({
          system: {
            characteristics: {
              STR: { value: 8, show: true },
              DEX: { value: 9, show: true },
              END: { value: 7, show: true },
            },
            skills: expect.objectContaining({
              pilot: expect.objectContaining({
                value: 2,
                specialities: expect.objectContaining({
                  smallCraft: { value: 2, trained: true },
                }),
              }),
              admin: { id: 'admin', value: 1, trained: true },
            }),
          },
        }),
      })
    );
  });

  it('normalizes nested and dotted MGT2e actor updates before audited dispatch', async () => {
    const { tools, query } = createTools({ withMgt2e: true });
    query.mockImplementation(async method =>
      method === 'foundry-mcp-bridge.getWorldInfo' ? { system: 'mgt2e' } : { success: true }
    );

    await tools.handleToolCall('update-document', {
      ref: { uuid: 'Actor.abc123' },
      updates: {
        system: { skills: { Admin: 3 } },
        'system.skills.Pilot': 2,
      },
      dryRun: true,
    });

    expect(query).toHaveBeenLastCalledWith(
      'foundry-mcp-bridge.updateDocument',
      expect.objectContaining({
        ref: { uuid: 'Actor.abc123' },
        dryRun: true,
        updates: {
          system: { skills: { admin: { id: 'admin', value: 3, trained: true } } },
          'system.skills.pilot': {
            value: 2,
            trained: true,
            specialities: { smallCraft: { value: 2, trained: true } },
          },
        },
      })
    );
  });

  it('normalizes every actor write in a batch with one routed system lookup', async () => {
    const { tools, query } = createTools({ withMgt2e: true });
    query.mockImplementation(async method =>
      method === 'foundry-mcp-bridge.getWorldInfo' ? { system: 'mgt2e' } : { success: true }
    );

    await tools.handleToolCall('batch-document-operations', {
      operations: [
        {
          action: 'create',
          documentType: 'Actor',
          data: { name: 'One', system: { skills: { admin: 1 } } },
        },
        {
          action: 'update',
          ref: { documentType: 'Actor', id: 'two' },
          updates: { system: { skills: { stealth: 2 } } },
        },
      ],
    });

    expect(
      query.mock.calls.filter(([method]) => method === 'foundry-mcp-bridge.getWorldInfo')
    ).toHaveLength(1);
    expect(query).toHaveBeenLastCalledWith(
      'foundry-mcp-bridge.batchDocumentOperations',
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            data: expect.objectContaining({
              system: { skills: { admin: { id: 'admin', value: 1, trained: true } } },
            }),
          }),
          expect.objectContaining({
            updates: {
              system: { skills: { stealth: { id: 'stealth', value: 2, trained: true } } },
            },
          }),
        ],
      })
    );
  });

  it('normalizes MGT2e actor-builder specs without replacing the audited builder', async () => {
    const { tools, query } = createTools({ withMgt2e: true });
    query.mockImplementation(async method =>
      method === 'foundry-mcp-bridge.getWorldInfo' ? { system: 'mgt2e' } : { success: true }
    );

    await tools.handleToolCall('build-actor-from-spec', {
      spec: { name: 'Scout', type: 'traveller', system: { skills: { recon: 2 } } },
    });

    expect(query).toHaveBeenLastCalledWith('foundry-mcp-bridge.buildActorFromSpec', {
      spec: expect.objectContaining({
        name: 'Scout',
        system: { skills: { recon: { id: 'recon', value: 2, trained: true } } },
      }),
    });
  });

  it('adds bounded active-system guidance to the existing Actor schema response', async () => {
    const { tools, query } = createTools({ withMgt2e: true });
    query.mockImplementation(async method => {
      if (method === 'foundry-mcp-bridge.getDocumentSchema') {
        return { success: true, schema: { documentType: 'Actor', fields: [] } };
      }
      return { system: 'mgt2e' };
    });

    const result = await tools.handleToolCall('get-document-schema', { documentType: 'Actor' });

    expect(result.schema.systemGuidance).toEqual({
      systemId: 'mgt2e',
      text: expect.stringContaining('mgt2e Actor Schema Reference'),
    });
  });
});
