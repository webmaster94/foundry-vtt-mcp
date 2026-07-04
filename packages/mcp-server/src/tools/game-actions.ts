import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FoundryClient } from '../foundry-client.js';
import { ServerRegistry } from '../server-registry.js';
import { Logger } from '../logger.js';

export interface GameActionToolsOptions {
  foundryClient: FoundryClient;
  registry: ServerRegistry;
  logger: Logger;
}

const TargetSchema = z.object({
  uuid: z.string().optional(),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
  tokenId: z.string().optional(),
});

const WAIT_CAP_MS = 55_000; // stay under typical MCP client tool timeouts

/**
 * Combat execution, game events, assets, effects, scene building, and server
 * diagnostics — the v0.11 "run the encounter with me" surface.
 */
export class GameActionTools {
  private foundryClient: FoundryClient;
  private registry: ServerRegistry;
  private logger: Logger;

  constructor({ foundryClient, registry, logger }: GameActionToolsOptions) {
    this.foundryClient = foundryClient;
    this.registry = registry;
    this.logger = logger.child({ component: 'GameActionTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      this.tool(
        'roll-initiative',
        'Roll initiative for the active combat (or combatRef). mode: all | npc | ids.',
        {
          combatRef: { type: 'object' },
          mode: { type: 'string', enum: ['all', 'npc', 'ids'], default: 'all' },
          combatantIds: { type: 'array', items: { type: 'string' } },
        }
      ),
      this.tool(
        'apply-damage',
        'Apply damage to an actor/token (temp HP absorbs first, HP clamps at 0). Audited and undoable.',
        {
          target: { type: 'object', description: '{uuid | tokenId | actorId | actorName}' },
          amount: { type: 'number' },
        },
        ['target', 'amount']
      ),
      this.tool(
        'apply-healing',
        'Heal an actor/token (clamps at max HP). Audited and undoable.',
        {
          target: { type: 'object', description: '{uuid | tokenId | actorId | actorName}' },
          amount: { type: 'number' },
        },
        ['target', 'amount']
      ),
      this.tool(
        'add-active-effect',
        'Add a buff/debuff ActiveEffect: changes [{key, mode, value}] (mode 2=ADD, 5=OVERRIDE; e.g. key "system.attributes.ac.bonus"), duration {rounds|seconds|turns}. Undoable.',
        {
          target: { type: 'object' },
          name: { type: 'string' },
          changes: { type: 'array', items: { type: 'object' } },
          duration: { type: 'object' },
          img: { type: 'string' },
          description: { type: 'string' },
        },
        ['target', 'name']
      ),
      this.tool(
        'get-roll-results',
        'Recent dice results from chat (requested player rolls and organic rolls), newest first.',
        {
          limit: { type: 'number', default: 10 },
          sinceMessageId: { type: 'string' },
        }
      ),
      this.tool(
        'get-recent-events',
        'Game events pushed by Foundry (combat-started/combat-turn/combat-ended/chat-message/roll-completed). Use seq cursors for incremental reads.',
        {
          sinceSeq: { type: 'number' },
          types: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number', default: 25 },
        }
      ),
      this.tool(
        'wait-for-event',
        'Long-poll for the next matching game event (up to 55s). Returns immediately if a matching event arrived after sinceSeq. Ideal loop: note latestSeq, act, wait-for-event {sinceSeq}.',
        {
          sinceSeq: {
            type: 'number',
            description: 'Only events after this sequence number (default: now)',
          },
          types: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number', default: 30000 },
        }
      ),
      this.tool(
        'browse-assets',
        'List files/folders in Foundry data (images, audio...). Use for portraits, token art, scene backgrounds.',
        {
          directory: { type: 'string', default: '' },
          source: { type: 'string', default: 'data' },
          extensions: { type: 'array', items: { type: 'string' } },
        }
      ),
      this.tool(
        'upload-asset',
        'Upload a small file (max 5MB, base64) into Foundry data; returns the path for use as img/texture/background.',
        {
          filename: { type: 'string' },
          base64: { type: 'string' },
          directory: { type: 'string', description: 'default: worlds/<world>/mcp-assets' },
          mimeType: { type: 'string' },
        },
        ['filename', 'base64']
      ),
      this.tool(
        'build-scene-from-spec',
        'Build a complete Scene in one call: background image, dimensions/grid, lights, walls, tokens placed by actor name, optional activate. Undoable as a group.',
        {
          spec: {
            type: 'object',
            description:
              '{name, background?, width?, height?, grid?{size,distance,units}, darkness?, lights?[{x,y,dim,bright,color}], walls?[{c:[x1,y1,x2,y2],door?}], tokens?[{actorName|actorId,x,y,hidden?}], activate?, folder?}',
          },
        },
        ['spec']
      ),
      this.tool(
        'build-actors-from-spec',
        'Build several actors (an encounter or party) in one call; same spec shape as build-actor-from-spec, shared undo group.',
        {
          specs: {
            type: 'array',
            items: { type: 'object' },
            description: 'Up to 20 ActorSpec objects',
          },
        },
        ['specs']
      ),
      this.tool(
        'get-bridge-logs',
        "Tail the MCP server's own log files for self-diagnosis (distinct from get-mcp-audit-log and browser console).",
        {
          file: { type: 'string', enum: ['server', 'wrapper'], default: 'server' },
          lines: { type: 'number', default: 50 },
          level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] },
          search: { type: 'string' },
        }
      ),
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    switch (name) {
      case 'roll-initiative':
        return this.query('rollInitiative', args || {});
      case 'apply-damage':
        return this.query('applyDamage', {
          target: TargetSchema.parse(args?.target || {}),
          amount: z.number().parse(args?.amount),
        });
      case 'apply-healing':
        return this.query('applyHealing', {
          target: TargetSchema.parse(args?.target || {}),
          amount: z.number().parse(args?.amount),
        });
      case 'add-active-effect':
        return this.query('addActiveEffect', args || {});
      case 'get-roll-results':
        return this.query('getRollResults', args || {});
      case 'get-recent-events': {
        const events = this.registry.getEventsSince(args || {});
        return { latestSeq: this.registry.latestEventSeq(), count: events.length, events };
      }
      case 'wait-for-event':
        return this.waitForEvent(args || {});
      case 'browse-assets':
        return this.query('browseAssets', args || {});
      case 'upload-asset':
        return this.query('uploadAsset', args || {});
      case 'build-scene-from-spec':
        return this.query('buildSceneFromSpec', { spec: args?.spec || {} });
      case 'build-actors-from-spec':
        return this.query('buildActorsFromSpec', { specs: args?.specs || [] });
      case 'get-bridge-logs':
        return this.getBridgeLogs(args || {});
      default:
        throw new Error(`Unknown game action tool: ${name}`);
    }
  }

  private async waitForEvent(args: {
    sinceSeq?: number;
    types?: string[];
    timeoutMs?: number;
  }): Promise<any> {
    const sinceSeq =
      typeof args.sinceSeq === 'number' ? args.sinceSeq : this.registry.latestEventSeq();
    const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 30_000, 1_000), WAIT_CAP_MS);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const events = this.registry.getEventsSince({
        sinceSeq,
        ...(args.types?.length ? { types: args.types } : {}),
        limit: 10,
      });
      if (events.length) {
        return { matched: true, latestSeq: this.registry.latestEventSeq(), events };
      }
      if (Date.now() >= deadline) {
        return {
          matched: false,
          latestSeq: this.registry.latestEventSeq(),
          note: `No matching event within ${timeoutMs}ms. Re-call with the same sinceSeq (${sinceSeq}) to keep waiting.`,
          sinceSeq,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  private async getBridgeLogs(args: {
    file?: string;
    lines?: number;
    level?: string;
    search?: string;
  }): Promise<any> {
    const dir = path.join(os.tmpdir(), 'foundry-mcp-server');
    const file = path.join(dir, args.file === 'wrapper' ? 'wrapper.log' : 'mcp-server.log');
    if (!fs.existsSync(file)) {
      return { file, exists: false, lines: [] };
    }

    const limit = Math.min(Math.max(args.lines ?? 50, 1), 500);
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let selected = raw;
    if (args.level) {
      selected = selected.filter(line => line.includes(`"level":"${args.level}"`));
    }
    if (args.search) {
      const needle = args.search.toLowerCase();
      selected = selected.filter(line => line.toLowerCase().includes(needle));
    }
    selected = selected.slice(-limit);

    return {
      file,
      totalLines: raw.length,
      returned: selected.length,
      lines: selected.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      }),
    };
  }

  private async query(method: string, params: any): Promise<any> {
    return this.foundryClient.query(`foundry-mcp-bridge.${method}`, params);
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
}
