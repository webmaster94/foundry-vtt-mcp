import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface BrowserConsoleToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const consoleLevelValues = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'table',
  'dir',
  'dirxml',
  'group',
  'groupCollapsed',
  'groupEnd',
  'time',
  'timeLog',
  'timeEnd',
  'count',
  'countReset',
  'assert',
  'clear',
] as const;

const BrowserConsoleQuerySchema = z.object({
  levels: z.array(z.enum(consoleLevelValues)).optional(),
  sinceId: z.number().int().nonnegative().optional(),
  sinceTimestamp: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  search: z.string().optional(),
  includeStack: z.boolean().optional().default(true),
  includeRawArgs: z.boolean().optional().default(false),
});

const ClearBrowserConsoleSchema = z.object({
  confirmClear: z.boolean().optional().default(false),
});

export class BrowserConsoleTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: BrowserConsoleToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'BrowserConsoleTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'get-browser-console',
        description: 'Read recent GM browser console output captured by the Foundry MCP Bridge. Captures console logs, info, warnings, errors, debug/trace/table output, window errors, unhandled promise rejections, resource load errors, and Foundry notification messages since the module loaded.',
        inputSchema: {
          type: 'object',
          properties: {
            levels: {
              type: 'array',
              description: 'Optional console levels to include. Defaults to all captured levels.',
              items: {
                type: 'string',
                enum: [...consoleLevelValues],
              },
            },
            sinceId: {
              type: 'number',
              description: 'Only return entries with an id greater than this value.',
            },
            sinceTimestamp: {
              type: 'string',
              description: 'Only return entries at or after this ISO timestamp.',
            },
            limit: {
              type: 'number',
              description: 'Maximum entries to return (default 100, max 500).',
              default: 100,
            },
            search: {
              type: 'string',
              description: 'Case-insensitive text filter applied to the rendered console message.',
            },
            includeStack: {
              type: 'boolean',
              description: 'Whether to include captured stack traces when available (default true).',
              default: true,
            },
            includeRawArgs: {
              type: 'boolean',
              description: 'Whether to include safely serialized console arguments (default false).',
              default: false,
            },
          },
        },
      },
      {
        name: 'clear-browser-console',
        description: 'Clear the MCP browser console capture buffer. Requires confirmClear=true. This does not clear the browser devtools console.',
        inputSchema: {
          type: 'object',
          properties: {
            confirmClear: {
              type: 'boolean',
              description: 'Must be true to confirm clearing the captured console buffer.',
            },
          },
          required: ['confirmClear'],
        },
      },
      {
        name: 'get-browser-console-status',
        description: 'Get browser console capture status, buffer size, and capture limits for the connected GM browser tab.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleGetBrowserConsole(args: any): Promise<any> {
    const params = BrowserConsoleQuerySchema.parse(args || {});
    this.logger.info('Getting browser console entries', {
      limit: params.limit,
      levels: params.levels,
      sinceId: params.sinceId,
      hasSearch: !!params.search,
    });

    return await this.foundryClient.query('foundry-mcp-bridge.getBrowserConsole', params);
  }

  async handleClearBrowserConsole(args: any): Promise<any> {
    const params = ClearBrowserConsoleSchema.parse(args || {});
    if (!params.confirmClear) {
      throw new Error('clear-browser-console requires confirmClear=true');
    }

    this.logger.info('Clearing browser console capture buffer');
    return await this.foundryClient.query('foundry-mcp-bridge.clearBrowserConsole', params);
  }

  async handleGetBrowserConsoleStatus(_args: any): Promise<any> {
    this.logger.info('Getting browser console capture status');
    return await this.foundryClient.query('foundry-mcp-bridge.getBrowserConsoleStatus', {});
  }
}
