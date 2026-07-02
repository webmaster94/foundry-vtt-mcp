import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  ActorSpecSchema,
  BatchDocumentOperationsRequestSchema,
  CompendiumContentSearchRequestSchema,
  CreateDocumentRequestSchema,
  CreateEmbeddedDocumentRequestSchema,
  CreateEmbeddedDocumentsRequestSchema,
  DeleteDocumentRequestSchema,
  DeleteEmbeddedDocumentRequestSchema,
  DocumentSchemaRequestSchema,
  GetDocumentRequestSchema,
  GetEmbeddedDocumentRequestSchema,
  ListDocumentsRequestSchema,
  ListEmbeddedDocumentsRequestSchema,
  UpdateDocumentRequestSchema,
  UpdateEmbeddedDocumentRequestSchema,
} from '@foundry-mcp/shared';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface DocumentManagementToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const RefSchema = z.object({
  uuid: z.string().optional(),
  documentType: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  packId: z.string().optional(),
});

const WorkflowDataSchema = z.record(z.unknown()).default({});

const workflowListTypes: Record<string, string> = {
  'list-world-items': 'Item',
  'list-roll-tables': 'RollTable',
  'list-folders': 'Folder',
  'list-chat-messages': 'ChatMessage',
  'list-combats': 'Combat',
  'list-playlists': 'Playlist',
  'list-card-stacks': 'Cards',
};

const workflowCreateTypes: Record<string, string> = {
  'create-world-item': 'Item',
  'create-roll-table': 'RollTable',
  'create-folder': 'Folder',
  'create-chat-message': 'ChatMessage',
  'create-combat': 'Combat',
  'create-playlist': 'Playlist',
  'create-card-stack': 'Cards',
};

const workflowUpdateTypes: Record<string, string> = {
  'update-world-item': 'Item',
  'update-roll-table': 'RollTable',
  'update-folder': 'Folder',
  'update-combat': 'Combat',
  'update-playlist': 'Playlist',
  'update-card-stack': 'Cards',
};

const workflowDeleteTypes: Record<string, string> = {
  'delete-world-item': 'Item',
  'delete-roll-table': 'RollTable',
  'delete-folder': 'Folder',
  'delete-combat': 'Combat',
  'delete-playlist': 'Playlist',
  'delete-card-stack': 'Cards',
};

export class DocumentManagementTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DocumentManagementToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DocumentManagementTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      this.tool(
        'list-document-types',
        'List supported Foundry document types, mutation policy, and embedded document support.',
        {}
      ),
      this.tool(
        'list-documents',
        'List world or compendium documents of a given type.',
        {
          documentType: { type: 'string' },
          packId: { type: 'string' },
          search: { type: 'string' },
          limit: { type: 'number', default: 50 },
          fields: { type: 'array', items: { type: 'string' } },
          includeSystem: { type: 'boolean', default: true },
          includeFlags: { type: 'boolean', default: false },
          includeSource: { type: 'boolean', default: false },
        },
        ['documentType']
      ),
      this.tool(
        'get-document',
        'Get one Foundry document by uuid, id/name + documentType, or packId + id.',
        {
          ref: { type: 'object' },
          fields: { type: 'array', items: { type: 'string' } },
          includeSystem: { type: 'boolean', default: true },
          includeFlags: { type: 'boolean', default: false },
          includeSource: { type: 'boolean', default: false },
          includeEmbedded: { type: 'boolean', default: false },
        },
        ['ref']
      ),
      this.tool(
        'create-document',
        'Create a Foundry world document. Requires write operations enabled.',
        {
          documentType: { type: 'string' },
          data: { type: 'object' },
          confirmBulkOperation: { type: 'boolean', default: false },
        },
        ['documentType', 'data']
      ),
      this.tool(
        'update-document',
        'Update a Foundry world document. Requires write operations enabled. Pass dryRun=true to preview the before/after diff without applying.',
        {
          ref: { type: 'object' },
          updates: { type: 'object' },
          dryRun: { type: 'boolean', default: false },
        },
        ['ref', 'updates']
      ),
      this.tool(
        'delete-document',
        'Delete a Foundry world document. Requires confirmDeletion=true. Pass dryRun=true to preview what would be deleted (with embedded counts) without applying.',
        {
          ref: { type: 'object' },
          confirmDeletion: { type: 'boolean' },
          dryRun: { type: 'boolean', default: false },
        },
        ['ref']
      ),
      this.tool(
        'list-embedded-documents',
        'List embedded documents under a parent document UUID.',
        {
          parentUuid: { type: 'string' },
          embeddedType: { type: 'string' },
          search: { type: 'string' },
          limit: { type: 'number', default: 50 },
        },
        ['parentUuid', 'embeddedType']
      ),
      this.tool(
        'get-embedded-document',
        'Get an embedded document by parent UUID and embedded id or name.',
        {
          ref: { type: 'object' },
        },
        ['ref']
      ),
      this.tool(
        'create-embedded-document',
        'Create an embedded document under a parent document UUID.',
        {
          parentUuid: { type: 'string' },
          embeddedType: { type: 'string' },
          data: { type: 'object' },
          confirmBulkOperation: { type: 'boolean', default: false },
        },
        ['parentUuid', 'embeddedType', 'data']
      ),
      this.tool(
        'create-embedded-documents',
        'Create MANY embedded documents under one parent in a single call (e.g. add 20 spells to an actor at once). Preferred over repeated create-embedded-document calls.',
        {
          parentUuid: { type: 'string' },
          embeddedType: { type: 'string' },
          data: {
            type: 'array',
            items: { type: 'object' },
            description: 'Array of embedded document data (max 100)',
          },
        },
        ['parentUuid', 'embeddedType', 'data']
      ),
      this.tool(
        'update-embedded-document',
        'Update an embedded document under a parent document UUID. Pass dryRun=true to preview the diff.',
        {
          ref: { type: 'object' },
          updates: { type: 'object' },
          dryRun: { type: 'boolean', default: false },
        },
        ['ref', 'updates']
      ),
      this.tool(
        'delete-embedded-document',
        'Delete an embedded document under a parent document UUID. Requires confirmDeletion=true.',
        {
          ref: { type: 'object' },
          confirmDeletion: { type: 'boolean' },
        },
        ['ref', 'confirmDeletion']
      ),
      this.tool(
        'get-document-schema',
        'Get a clean field-path summary for a Foundry document type: dotted paths, types, constraints, subtypes, and per-subtype system template keys. Use these paths in update payloads.',
        {
          documentType: { type: 'string' },
        },
        ['documentType']
      ),
      this.tool(
        'batch-document-operations',
        'Execute up to 50 document operations in order (create/update/delete, embedded variants). Stops at first failure unless continueOnError=true. Each op object needs an "action" plus that action\'s normal arguments.',
        {
          operations: { type: 'array', items: { type: 'object' } },
          continueOnError: { type: 'boolean', default: false },
        },
        ['operations']
      ),
      this.tool(
        'build-actor-from-spec',
        'Build a COMPLETE actor from one declarative spec: optional compendium template clone, system-data overrides, spells and items resolved from compendia by name, inline custom features, folder placement, and biography. Returns unresolved names so you can fix gaps. Far fewer round trips than assembling manually.',
        {
          spec: {
            type: 'object',
            description:
              'ActorSpec: { name, type?, folder?, template?{packId,entryId|name}, system?, spells?[names], items?[{name,rename?,quantity?,system?,description?}], features?[{name,description,activation?}], biography?, prototypeToken?, dropTemplateWeapons?, replaceTemplateSpells?, img? }',
          },
        },
        ['spec']
      ),
      this.tool(
        'search-compendium-contents',
        'Search compendia on REAL system data via indexed fields: filters like {path:"system.level",op:"lte",value:3}, name substring, optional description full-text (text param; capped). Far more precise than search-compendium name matching.',
        {
          documentType: { type: 'string', default: 'Item' },
          packIds: { type: 'array', items: { type: 'string' } },
          name: { type: 'string' },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                op: {
                  type: 'string',
                  enum: ['eq', 'lte', 'gte', 'lt', 'gt', 'ne', 'in', 'contains'],
                },
                value: {},
              },
              required: ['path', 'value'],
            },
          },
          text: {
            type: 'string',
            description: 'Full-text search over descriptions (loads documents; capped at 2000)',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra index fields to include in results, e.g. "system.level"',
          },
          limit: { type: 'number', default: 25 },
        }
      ),
      this.tool(
        'undo-last-mcp-operation',
        'Revert the most recent undoable MCP write (create/update/delete of documents or embedded documents, including build-actor-from-spec). Requires confirmUndo=true. Check get-mcp-audit-log to see what will be undone.',
        {
          confirmUndo: { type: 'boolean' },
        },
        ['confirmUndo']
      ),
      ...this.workflowToolDefinitions(),
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    this.logger.info('Document tool requested', { name });

    switch (name) {
      case 'list-document-types':
        return this.query('listDocumentTypes', {});
      case 'list-documents':
        return this.query('listDocuments', ListDocumentsRequestSchema.parse(args || {}));
      case 'get-document':
        return this.query('getDocument', GetDocumentRequestSchema.parse(args || {}));
      case 'create-document':
        return this.query('createDocument', CreateDocumentRequestSchema.parse(args || {}));
      case 'update-document':
        return this.query('updateDocument', UpdateDocumentRequestSchema.parse(args || {}));
      case 'delete-document':
        return this.query('deleteDocument', DeleteDocumentRequestSchema.parse(args || {}));
      case 'list-embedded-documents':
        return this.query(
          'listEmbeddedDocuments',
          ListEmbeddedDocumentsRequestSchema.parse(args || {})
        );
      case 'get-embedded-document':
        return this.query(
          'getEmbeddedDocument',
          GetEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'create-embedded-document':
        return this.query(
          'createEmbeddedDocument',
          CreateEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'create-embedded-documents':
        return this.query(
          'createEmbeddedDocuments',
          CreateEmbeddedDocumentsRequestSchema.parse(args || {})
        );
      case 'batch-document-operations':
        return this.query(
          'batchDocumentOperations',
          BatchDocumentOperationsRequestSchema.parse(args || {})
        );
      case 'build-actor-from-spec':
        return this.query('buildActorFromSpec', { spec: ActorSpecSchema.parse(args?.spec || {}) });
      case 'search-compendium-contents':
        return this.query(
          'searchCompendiumContents',
          CompendiumContentSearchRequestSchema.parse(args || {})
        );
      case 'undo-last-mcp-operation':
        return this.query('undoLastOperation', { confirmUndo: args?.confirmUndo === true });
      case 'update-embedded-document':
        return this.query(
          'updateEmbeddedDocument',
          UpdateEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'delete-embedded-document':
        return this.query(
          'deleteEmbeddedDocument',
          DeleteEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'get-document-schema':
        return this.query('getDocumentSchema', DocumentSchemaRequestSchema.parse(args || {}));
      case 'roll-roll-table':
        return this.query('rollRollTable', { ref: this.refWithType(args, 'RollTable') });
      case 'move-document-to-folder':
        return this.query('updateDocument', {
          ref: RefSchema.parse(args?.ref || {}),
          updates: { folder: z.string().parse(args?.folderId) },
        });
      case 'delete-chat-messages':
        return this.deleteChatMessages(args);
      case 'advance-combat':
        return this.query('combatAction', {
          ref: this.refWithType(args, 'Combat'),
          action: 'advance',
        });
      case 'update-combatant':
        return this.query(
          'updateEmbeddedDocument',
          UpdateEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'play-playlist-sound':
        return this.query('playlistSoundAction', {
          ref: this.refWithType(args, 'Playlist'),
          soundId: z.string().parse(args?.soundId),
          action: 'play',
        });
      case 'stop-playlist-sound':
        return this.query('playlistSoundAction', {
          ref: this.refWithType(args, 'Playlist'),
          soundId: z.string().parse(args?.soundId),
          action: 'stop',
        });
      case 'shuffle-card-stack':
        return this.query('cardsAction', {
          ref: this.refWithType(args, 'Cards'),
          action: 'shuffle',
        });
      case 'draw-card':
        return this.query('cardsAction', { ref: this.refWithType(args, 'Cards'), action: 'draw' });
      case 'list-scene-embedded-documents':
        return this.query(
          'listEmbeddedDocuments',
          ListEmbeddedDocumentsRequestSchema.parse(args || {})
        );
      case 'create-scene-embedded-document':
        return this.query(
          'createEmbeddedDocument',
          CreateEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'update-scene-embedded-document':
        return this.query(
          'updateEmbeddedDocument',
          UpdateEmbeddedDocumentRequestSchema.parse(args || {})
        );
      case 'delete-scene-embedded-document':
        return this.query(
          'deleteEmbeddedDocument',
          DeleteEmbeddedDocumentRequestSchema.parse(args || {})
        );
      default:
        if (workflowListTypes[name]) return this.listWorkflowDocuments(name, args);
        if (workflowCreateTypes[name]) return this.createWorkflowDocument(name, args);
        if (workflowUpdateTypes[name]) return this.updateWorkflowDocument(name, args);
        if (workflowDeleteTypes[name]) return this.deleteWorkflowDocument(name, args);
        throw new Error(`Unknown document tool: ${name}`);
    }
  }

  private async query(method: string, params: any): Promise<any> {
    return this.foundryClient.query(`foundry-mcp-bridge.${method}`, params);
  }

  private listWorkflowDocuments(name: string, args: any): Promise<any> {
    return this.query('listDocuments', {
      ...(args || {}),
      documentType: workflowListTypes[name],
    });
  }

  private createWorkflowDocument(name: string, args: any): Promise<any> {
    const documentType = workflowCreateTypes[name];
    const data = WorkflowDataSchema.parse(args?.data || this.pickData(args || {}));
    return this.query('createDocument', {
      documentType,
      data,
      confirmBulkOperation: args?.confirmBulkOperation || false,
    });
  }

  private updateWorkflowDocument(name: string, args: any): Promise<any> {
    const documentType = workflowUpdateTypes[name];
    const ref = this.refWithType(args, documentType);
    return this.query('updateDocument', {
      ref,
      updates: z.record(z.unknown()).parse(args?.updates || {}),
    });
  }

  private deleteWorkflowDocument(name: string, args: any): Promise<any> {
    const documentType = workflowDeleteTypes[name];
    return this.query('deleteDocument', {
      ref: this.refWithType(args, documentType),
      confirmDeletion: args?.confirmDeletion === true,
    });
  }

  private async deleteChatMessages(args: any): Promise<any> {
    const ids = z
      .array(z.string())
      .min(1)
      .parse(args?.ids || []);
    if (args?.confirmDeletion !== true)
      throw new Error('delete-chat-messages requires confirmDeletion=true');
    const results = [];
    for (const id of ids) {
      results.push(
        await this.query('deleteDocument', {
          ref: { documentType: 'ChatMessage', id },
          confirmDeletion: true,
        })
      );
    }
    return { success: true, results };
  }

  private refWithType(args: any, documentType: string): Record<string, unknown> {
    const ref = RefSchema.parse(args?.ref || {});
    return { ...ref, documentType: ref.documentType || documentType };
  }

  private pickData(args: Record<string, unknown>): Record<string, unknown> {
    const skip = new Set([
      'ref',
      'updates',
      'confirmDeletion',
      'confirmBulkOperation',
      'fields',
      'limit',
      'search',
    ]);
    return Object.fromEntries(Object.entries(args).filter(([key]) => !skip.has(key)));
  }

  private workflowToolDefinitions(): Tool[] {
    const tools: Tool[] = [];
    for (const name of Object.keys(workflowListTypes))
      tools.push(this.tool(name, `List ${workflowListTypes[name]} documents.`, this.listProps()));
    for (const name of Object.keys(workflowCreateTypes))
      tools.push(
        this.tool(name, `Create a ${workflowCreateTypes[name]} document.`, this.createProps())
      );
    for (const name of Object.keys(workflowUpdateTypes))
      tools.push(
        this.tool(name, `Update a ${workflowUpdateTypes[name]} document.`, this.updateProps(), [
          'ref',
          'updates',
        ])
      );
    for (const name of Object.keys(workflowDeleteTypes))
      tools.push(
        this.tool(
          name,
          `Delete a ${workflowDeleteTypes[name]} document. Requires confirmDeletion=true.`,
          this.deleteProps(),
          ['ref', 'confirmDeletion']
        )
      );
    tools.push(
      this.tool('roll-roll-table', 'Roll or draw from a RollTable.', { ref: { type: 'object' } }, [
        'ref',
      ]),
      this.tool(
        'move-document-to-folder',
        'Move a document to a folder by updating its folder id.',
        { ref: { type: 'object' }, folderId: { type: 'string' } },
        ['ref', 'folderId']
      ),
      this.tool(
        'delete-chat-messages',
        'Delete one or more ChatMessage documents. Requires confirmDeletion=true.',
        { ids: { type: 'array', items: { type: 'string' } }, confirmDeletion: { type: 'boolean' } },
        ['ids', 'confirmDeletion']
      ),
      this.tool(
        'advance-combat',
        'Advance a Combat to the next turn.',
        { ref: { type: 'object' } },
        ['ref']
      ),
      this.tool(
        'update-combatant',
        'Update a Combatant embedded document. Use parentUuid for the Combat UUID.',
        { ref: { type: 'object' }, updates: { type: 'object' } },
        ['ref', 'updates']
      ),
      this.tool(
        'play-playlist-sound',
        'Play a PlaylistSound from a Playlist.',
        { ref: { type: 'object' }, soundId: { type: 'string' } },
        ['ref', 'soundId']
      ),
      this.tool(
        'stop-playlist-sound',
        'Stop a PlaylistSound from a Playlist.',
        { ref: { type: 'object' }, soundId: { type: 'string' } },
        ['ref', 'soundId']
      ),
      this.tool('shuffle-card-stack', 'Shuffle a Cards stack.', { ref: { type: 'object' } }, [
        'ref',
      ]),
      this.tool('draw-card', 'Draw from a Cards stack.', { ref: { type: 'object' } }, ['ref']),
      this.tool(
        'list-scene-embedded-documents',
        'List Scene embedded documents such as Token, Wall, Tile, Drawing, AmbientLight, AmbientSound, or Note.',
        this.embeddedListProps(),
        ['parentUuid', 'embeddedType']
      ),
      this.tool(
        'create-scene-embedded-document',
        'Create a Scene embedded document.',
        this.embeddedCreateProps(),
        ['parentUuid', 'embeddedType', 'data']
      ),
      this.tool(
        'update-scene-embedded-document',
        'Update a Scene embedded document.',
        this.updateProps(),
        ['ref', 'updates']
      ),
      this.tool(
        'delete-scene-embedded-document',
        'Delete a Scene embedded document. Requires confirmDeletion=true.',
        this.deleteProps(),
        ['ref', 'confirmDeletion']
      )
    );
    return tools;
  }

  private tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = []
  ): Tool {
    return {
      name,
      description,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    };
  }

  private listProps(): Record<string, unknown> {
    return {
      search: { type: 'string' },
      limit: { type: 'number', default: 50 },
      fields: { type: 'array', items: { type: 'string' } },
    };
  }

  private createProps(): Record<string, unknown> {
    return {
      data: { type: 'object' },
      name: { type: 'string' },
      type: { type: 'string' },
      system: { type: 'object' },
      img: { type: 'string' },
      confirmBulkOperation: { type: 'boolean' },
    };
  }

  private updateProps(): Record<string, unknown> {
    return { ref: { type: 'object' }, updates: { type: 'object' } };
  }

  private deleteProps(): Record<string, unknown> {
    return { ref: { type: 'object' }, confirmDeletion: { type: 'boolean' } };
  }

  private embeddedListProps(): Record<string, unknown> {
    return {
      parentUuid: { type: 'string' },
      embeddedType: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'number', default: 50 },
    };
  }

  private embeddedCreateProps(): Record<string, unknown> {
    return {
      parentUuid: { type: 'string' },
      embeddedType: { type: 'string' },
      data: { type: 'object' },
      confirmBulkOperation: { type: 'boolean' },
    };
  }
}
