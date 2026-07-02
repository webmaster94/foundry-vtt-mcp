import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  MacroCreateRequestSchema,
  MacroExecuteRequestSchema,
  UpdateDocumentRequestSchema,
  DeleteDocumentRequestSchema,
} from '@foundry-mcp/shared';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface MacroManagementToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class MacroManagementTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: MacroManagementToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'MacroManagementTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      this.tool('list-macros', 'List Foundry Macros.', { search: { type: 'string' }, limit: { type: 'number', default: 50 } }),
      this.tool('get-macro', 'Get a Macro by uuid, id, or exact name.', { uuid: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' } }),
      this.tool('create-macro', 'Create a Foundry Macro.', {
        name: { type: 'string' },
        type: { type: 'string', enum: ['script', 'chat'], default: 'script' },
        command: { type: 'string' },
        img: { type: 'string' },
        folderId: { type: 'string' },
        ownership: { type: 'object' },
      }, ['name']),
      this.tool('update-macro', 'Update a Macro by ref.', {
        ref: { type: 'object' },
        updates: { type: 'object' },
      }, ['ref', 'updates']),
      this.tool('delete-macro', 'Delete a Macro. Requires confirmDeletion=true.', {
        ref: { type: 'object' },
        confirmDeletion: { type: 'boolean' },
      }, ['ref', 'confirmDeletion']),
      this.tool('execute-macro', 'Execute a Macro in the connected GM browser. Resolve by uuid, id, or exact name.', {
        uuid: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        actorUuid: { type: 'string' },
        tokenId: { type: 'string' },
        speaker: { type: 'object' },
      }),
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    this.logger.info('Macro tool requested', { name });

    switch (name) {
      case 'list-macros':
        return this.query('listDocuments', { ...(args || {}), documentType: 'Macro' });
      case 'get-macro':
        return this.query('getDocument', { ref: { ...this.parseMacroRef(args), documentType: 'Macro' } });
      case 'create-macro': {
        const parsed = MacroCreateRequestSchema.parse(args || {});
        const data: Record<string, unknown> = {
          name: parsed.name,
          type: parsed.type,
          command: parsed.command,
        };
        if (parsed.img) data.img = parsed.img;
        if (parsed.folderId) data.folder = parsed.folderId;
        if (parsed.ownership) data.ownership = parsed.ownership;
        return this.query('createDocument', { documentType: 'Macro', data });
      }
      case 'update-macro': {
        const parsed = UpdateDocumentRequestSchema.parse(args || {});
        return this.query('updateDocument', { ...parsed, ref: { ...parsed.ref, documentType: 'Macro' } });
      }
      case 'delete-macro': {
        const parsed = DeleteDocumentRequestSchema.parse(args || {});
        return this.query('deleteDocument', { ...parsed, ref: { ...parsed.ref, documentType: 'Macro' } });
      }
      case 'execute-macro':
        return this.query('executeMacro', MacroExecuteRequestSchema.parse(args || {}));
      default:
        throw new Error(`Unknown macro tool: ${name}`);
    }
  }

  private parseMacroRef(args: any): Record<string, unknown> {
    return z.object({
      uuid: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
    }).parse(args || {});
  }

  private query(method: string, params: any): Promise<any> {
    return this.foundryClient.query(`foundry-mcp-bridge.${method}`, params);
  }

  private tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Tool {
    return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
  }
}
