import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CreateDocumentRequestSchema,
  CreateEmbeddedDocumentRequestSchema,
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
      this.tool('list-document-types', 'List supported Foundry document types, mutation policy, and embedded document support.', {}),
      this.tool('list-documents', 'List world or compendium documents of a given type.', {
        documentType: { type: 'string' },
        packId: { type: 'string' },
        search: { type: 'string' },
        limit: { type: 'number', default: 50 },
        fields: { type: 'array', items: { type: 'string' } },
        includeSystem: { type: 'boolean', default: true },
        includeFlags: { type: 'boolean', default: false },
        includeSource: { type: 'boolean', default: false },
      }, ['documentType']),
      this.tool('get-document', 'Get one Foundry document by uuid, id/name + documentType, or packId + id.', {
        ref: { type: 'object' },
        fields: { type: 'array', items: { type: 'string' } },
        includeSystem: { type: 'boolean', default: true },
        includeFlags: { type: 'boolean', default: false },
        includeSource: { type: 'boolean', default: false },
        includeEmbedded: { type: 'boolean', default: false },
      }, ['ref']),
      this.tool('create-document', 'Create a Foundry world document. Requires write operations enabled.', {
        documentType: { type: 'string' },
        data: { type: 'object' },
        confirmBulkOperation: { type: 'boolean', default: false },
      }, ['documentType', 'data']),
      this.tool('update-document', 'Update a Foundry world document. Requires write operations enabled.', {
        ref: { type: 'object' },
        updates: { type: 'object' },
      }, ['ref', 'updates']),
      this.tool('delete-document', 'Delete a Foundry world document. Requires confirmDeletion=true.', {
        ref: { type: 'object' },
        confirmDeletion: { type: 'boolean' },
      }, ['ref', 'confirmDeletion']),
      this.tool('list-embedded-documents', 'List embedded documents under a parent document UUID.', {
        parentUuid: { type: 'string' },
        embeddedType: { type: 'string' },
        search: { type: 'string' },
        limit: { type: 'number', default: 50 },
      }, ['parentUuid', 'embeddedType']),
      this.tool('get-embedded-document', 'Get an embedded document by parent UUID and embedded id or name.', {
        ref: { type: 'object' },
      }, ['ref']),
      this.tool('create-embedded-document', 'Create an embedded document under a parent document UUID.', {
        parentUuid: { type: 'string' },
        embeddedType: { type: 'string' },
        data: { type: 'object' },
        confirmBulkOperation: { type: 'boolean', default: false },
      }, ['parentUuid', 'embeddedType', 'data']),
      this.tool('update-embedded-document', 'Update an embedded document under a parent document UUID.', {
        ref: { type: 'object' },
        updates: { type: 'object' },
      }, ['ref', 'updates']),
      this.tool('delete-embedded-document', 'Delete an embedded document under a parent document UUID. Requires confirmDeletion=true.', {
        ref: { type: 'object' },
        confirmDeletion: { type: 'boolean' },
      }, ['ref', 'confirmDeletion']),
      this.tool('get-document-schema', 'Get available schema/metadata for a Foundry document type.', {
        documentType: { type: 'string' },
      }, ['documentType']),
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
        return this.query('listEmbeddedDocuments', ListEmbeddedDocumentsRequestSchema.parse(args || {}));
      case 'get-embedded-document':
        return this.query('getEmbeddedDocument', GetEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'create-embedded-document':
        return this.query('createEmbeddedDocument', CreateEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'update-embedded-document':
        return this.query('updateEmbeddedDocument', UpdateEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'delete-embedded-document':
        return this.query('deleteEmbeddedDocument', DeleteEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'get-document-schema':
        return this.query('getDocumentSchema', DocumentSchemaRequestSchema.parse(args || {}));
      case 'roll-roll-table':
        return this.query('rollRollTable', { ref: this.refWithType(args, 'RollTable') });
      case 'move-document-to-folder':
        return this.query('updateDocument', { ref: RefSchema.parse(args?.ref || {}), updates: { folder: z.string().parse(args?.folderId) } });
      case 'delete-chat-messages':
        return this.deleteChatMessages(args);
      case 'advance-combat':
        return this.query('combatAction', { ref: this.refWithType(args, 'Combat'), action: 'advance' });
      case 'update-combatant':
        return this.query('updateEmbeddedDocument', UpdateEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'play-playlist-sound':
        return this.query('playlistSoundAction', { ref: this.refWithType(args, 'Playlist'), soundId: z.string().parse(args?.soundId), action: 'play' });
      case 'stop-playlist-sound':
        return this.query('playlistSoundAction', { ref: this.refWithType(args, 'Playlist'), soundId: z.string().parse(args?.soundId), action: 'stop' });
      case 'shuffle-card-stack':
        return this.query('cardsAction', { ref: this.refWithType(args, 'Cards'), action: 'shuffle' });
      case 'draw-card':
        return this.query('cardsAction', { ref: this.refWithType(args, 'Cards'), action: 'draw' });
      case 'list-scene-embedded-documents':
        return this.query('listEmbeddedDocuments', ListEmbeddedDocumentsRequestSchema.parse(args || {}));
      case 'create-scene-embedded-document':
        return this.query('createEmbeddedDocument', CreateEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'update-scene-embedded-document':
        return this.query('updateEmbeddedDocument', UpdateEmbeddedDocumentRequestSchema.parse(args || {}));
      case 'delete-scene-embedded-document':
        return this.query('deleteEmbeddedDocument', DeleteEmbeddedDocumentRequestSchema.parse(args || {}));
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
    return this.query('createDocument', { documentType, data, confirmBulkOperation: args?.confirmBulkOperation || false });
  }

  private updateWorkflowDocument(name: string, args: any): Promise<any> {
    const documentType = workflowUpdateTypes[name];
    const ref = this.refWithType(args, documentType);
    return this.query('updateDocument', { ref, updates: z.record(z.unknown()).parse(args?.updates || {}) });
  }

  private deleteWorkflowDocument(name: string, args: any): Promise<any> {
    const documentType = workflowDeleteTypes[name];
    return this.query('deleteDocument', {
      ref: this.refWithType(args, documentType),
      confirmDeletion: args?.confirmDeletion === true,
    });
  }

  private async deleteChatMessages(args: any): Promise<any> {
    const ids = z.array(z.string()).min(1).parse(args?.ids || []);
    if (args?.confirmDeletion !== true) throw new Error('delete-chat-messages requires confirmDeletion=true');
    const results = [];
    for (const id of ids) {
      results.push(await this.query('deleteDocument', { ref: { documentType: 'ChatMessage', id }, confirmDeletion: true }));
    }
    return { success: true, results };
  }

  private refWithType(args: any, documentType: string): Record<string, unknown> {
    const ref = RefSchema.parse(args?.ref || {});
    return { ...ref, documentType: ref.documentType || documentType };
  }

  private pickData(args: Record<string, unknown>): Record<string, unknown> {
    const skip = new Set(['ref', 'updates', 'confirmDeletion', 'confirmBulkOperation', 'fields', 'limit', 'search']);
    return Object.fromEntries(Object.entries(args).filter(([key]) => !skip.has(key)));
  }

  private workflowToolDefinitions(): Tool[] {
    const tools: Tool[] = [];
    for (const name of Object.keys(workflowListTypes)) tools.push(this.tool(name, `List ${workflowListTypes[name]} documents.`, this.listProps()));
    for (const name of Object.keys(workflowCreateTypes)) tools.push(this.tool(name, `Create a ${workflowCreateTypes[name]} document.`, this.createProps()));
    for (const name of Object.keys(workflowUpdateTypes)) tools.push(this.tool(name, `Update a ${workflowUpdateTypes[name]} document.`, this.updateProps(), ['ref', 'updates']));
    for (const name of Object.keys(workflowDeleteTypes)) tools.push(this.tool(name, `Delete a ${workflowDeleteTypes[name]} document. Requires confirmDeletion=true.`, this.deleteProps(), ['ref', 'confirmDeletion']));
    tools.push(
      this.tool('roll-roll-table', 'Roll or draw from a RollTable.', { ref: { type: 'object' } }, ['ref']),
      this.tool('move-document-to-folder', 'Move a document to a folder by updating its folder id.', { ref: { type: 'object' }, folderId: { type: 'string' } }, ['ref', 'folderId']),
      this.tool('delete-chat-messages', 'Delete one or more ChatMessage documents. Requires confirmDeletion=true.', { ids: { type: 'array', items: { type: 'string' } }, confirmDeletion: { type: 'boolean' } }, ['ids', 'confirmDeletion']),
      this.tool('advance-combat', 'Advance a Combat to the next turn.', { ref: { type: 'object' } }, ['ref']),
      this.tool('update-combatant', 'Update a Combatant embedded document. Use parentUuid for the Combat UUID.', { ref: { type: 'object' }, updates: { type: 'object' } }, ['ref', 'updates']),
      this.tool('play-playlist-sound', 'Play a PlaylistSound from a Playlist.', { ref: { type: 'object' }, soundId: { type: 'string' } }, ['ref', 'soundId']),
      this.tool('stop-playlist-sound', 'Stop a PlaylistSound from a Playlist.', { ref: { type: 'object' }, soundId: { type: 'string' } }, ['ref', 'soundId']),
      this.tool('shuffle-card-stack', 'Shuffle a Cards stack.', { ref: { type: 'object' } }, ['ref']),
      this.tool('draw-card', 'Draw from a Cards stack.', { ref: { type: 'object' } }, ['ref']),
      this.tool('list-scene-embedded-documents', 'List Scene embedded documents such as Token, Wall, Tile, Drawing, AmbientLight, AmbientSound, or Note.', this.embeddedListProps(), ['parentUuid', 'embeddedType']),
      this.tool('create-scene-embedded-document', 'Create a Scene embedded document.', this.embeddedCreateProps(), ['parentUuid', 'embeddedType', 'data']),
      this.tool('update-scene-embedded-document', 'Update a Scene embedded document.', this.updateProps(), ['ref', 'updates']),
      this.tool('delete-scene-embedded-document', 'Delete a Scene embedded document. Requires confirmDeletion=true.', this.deleteProps(), ['ref', 'confirmDeletion']),
    );
    return tools;
  }

  private tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Tool {
    return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
  }

  private listProps(): Record<string, unknown> {
    return { search: { type: 'string' }, limit: { type: 'number', default: 50 }, fields: { type: 'array', items: { type: 'string' } } };
  }

  private createProps(): Record<string, unknown> {
    return { data: { type: 'object' }, name: { type: 'string' }, type: { type: 'string' }, system: { type: 'object' }, img: { type: 'string' }, confirmBulkOperation: { type: 'boolean' } };
  }

  private updateProps(): Record<string, unknown> {
    return { ref: { type: 'object' }, updates: { type: 'object' } };
  }

  private deleteProps(): Record<string, unknown> {
    return { ref: { type: 'object' }, confirmDeletion: { type: 'boolean' } };
  }

  private embeddedListProps(): Record<string, unknown> {
    return { parentUuid: { type: 'string' }, embeddedType: { type: 'string' }, search: { type: 'string' }, limit: { type: 'number', default: 50 } };
  }

  private embeddedCreateProps(): Record<string, unknown> {
    return { parentUuid: { type: 'string' }, embeddedType: { type: 'string' }, data: { type: 'object' }, confirmBulkOperation: { type: 'boolean' } };
  }
}
