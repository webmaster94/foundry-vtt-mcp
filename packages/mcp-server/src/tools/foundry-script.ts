import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  FoundryScriptExecuteRequestSchema,
  QueryFoundryDataRequestSchema,
} from '@foundry-mcp/shared';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface FoundryScriptToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const AuditLogRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  operation: z.string().optional(),
  success: z.boolean().optional(),
});

const ClearAuditLogRequestSchema = z.object({
  confirmClear: z.boolean(),
});

export class FoundryScriptTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: FoundryScriptToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'FoundryScriptTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'execute-foundry-script',
        description: 'Execute JavaScript immediately in the connected GM browser. This is privileged browser execution, not Forge server execution.',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            mode: { type: 'string', enum: ['script', 'expression'], default: 'script' },
            timeoutMs: { type: 'number', default: 5000 },
            resultLimitBytes: { type: 'number', default: 256000 },
            description: { type: 'string' },
          },
          required: ['code'],
        },
      },
      {
        name: 'query-foundry-data',
        description: 'Read arbitrary common Foundry data through a constrained read-only query explorer. Prefer this before execute-foundry-script for reads.',
        inputSchema: {
          type: 'object',
          properties: {
            root: {
              type: 'string',
              enum: [
                'game.actors',
                'game.items',
                'game.scenes',
                'game.journal',
                'game.macros',
                'game.tables',
                'game.playlists',
                'game.cards',
                'game.combats',
                'game.folders',
                'game.users',
                'game.messages',
                'game.settings.storage',
              ],
            },
            filters: { type: 'object' },
            fields: { type: 'array', items: { type: 'string' } },
            sort: { type: 'object' },
            limit: { type: 'number', default: 50 },
            includeSource: { type: 'boolean', default: false },
            includeSystem: { type: 'boolean', default: true },
            includeFlags: { type: 'boolean', default: false },
          },
          required: ['root'],
        },
      },
      {
        name: 'get-mcp-audit-log',
        description: 'Read the MCP audit log for document writes, macro execution, script execution, and audit clearing.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 100 },
            operation: { type: 'string' },
            success: { type: 'boolean' },
          },
        },
      },
      {
        name: 'clear-mcp-audit-log',
        description: 'Clear the MCP audit log. Requires confirmClear=true.',
        inputSchema: {
          type: 'object',
          properties: {
            confirmClear: { type: 'boolean' },
          },
          required: ['confirmClear'],
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    this.logger.info('Foundry script/data tool requested', { name });

    switch (name) {
      case 'execute-foundry-script':
        return this.query('executeFoundryScript', FoundryScriptExecuteRequestSchema.parse(args || {}));
      case 'query-foundry-data':
        return this.query('queryFoundryData', QueryFoundryDataRequestSchema.parse(args || {}));
      case 'get-mcp-audit-log':
        return this.query('getMcpAuditLog', AuditLogRequestSchema.parse(args || {}));
      case 'clear-mcp-audit-log': {
        const parsed = ClearAuditLogRequestSchema.parse(args || {});
        if (!parsed.confirmClear) throw new Error('clear-mcp-audit-log requires confirmClear=true');
        return this.query('clearMcpAuditLog', parsed);
      }
      default:
        throw new Error(`Unknown Foundry script/data tool: ${name}`);
    }
  }

  private query(method: string, params: any): Promise<any> {
    return this.foundryClient.query(`foundry-mcp-bridge.${method}`, params);
  }
}
