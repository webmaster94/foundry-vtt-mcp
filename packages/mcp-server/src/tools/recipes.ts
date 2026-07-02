import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';

export interface RecipeToolsOptions {
  logger: Logger;
}

/**
 * Curated, system-specific knowledge for AI agents driving the bridge —
 * the non-obvious rules that make first attempts succeed.
 */
const RECIPES: Record<string, string> = {
  'dnd5e-npc-building': `# Building D&D 5e NPCs through the bridge

Preferred path: ONE call to build-actor-from-spec. Example spec:
{
  "name": "Korvas Dremm",
  "type": "npc",
  "folder": "Mine",
  "template": { "name": "Mage" },
  "system": {
    "attributes": { "hp": { "value": 78, "max": 78, "formula": "12d8+24" }, "ac": { "flat": 15, "calc": "flat" } },
    "abilities": { "int": { "value": 18, "proficient": 1 } },
    "details": { "cr": 6, "alignment": "Lawful Neutral" }
  },
  "spells": ["Fire Bolt", "Shield", "Counterspell", "Fireball"],
  "items": [{ "name": "Backpack", "rename": "Research Satchel", "description": "<p>The real prize.</p>" }],
  "features": [{ "name": "Sculpt Spells", "description": "<p>...</p>" }]
}

Key dnd5e rules the sheet derives FOR you (do not fight them):
- Spell save DC / attack bonus = 8 (or 0) + proficiency + spellcasting ability mod. Proficiency comes from CR: prof = 2 + floor((CR-1)/4). Set system.details.cr to land the DC you want (e.g. INT 18 + CR 6 -> DC 15, +7).
- Skills: system.skills.<abbr>.value is a multiplier (1 = proficient, 2 = expertise), not a flat bonus.
- AC: use { "flat": N, "calc": "flat" } to pin a value; "default" derives from armor items.
- Leveled spells on NPCs need system.preparation = { mode: "prepared", prepared: true } to be castable (build-actor-from-spec does this automatically).
- Spell slots: system.spells.spellN = { value, max, override }.
- Magic weapons: set system.magicalBonus and keep proficient: 1, equipped: true.
- Cloning a Monster Manual template ("Mage", "Warrior Veteran", "Gladiator") gets you correct actions/multiattack for free; override stats after.`,

  'document-api': `# Generic document API patterns

- Discover types: list-document-types. Discover field paths: get-document-schema (use its dotted paths in updates).
- Update with dotted keys: { "ref": {...}, "updates": { "system.attributes.hp.value": 40 } }.
- Preview first on risky edits: pass dryRun=true to update-document / delete-document to get a before/after diff without applying.
- Made a mistake? undo-last-mcp-operation { confirmUndo: true } reverts the last write (see get-mcp-audit-log for what that is).
- Many embedded docs at once: create-embedded-documents (array) instead of N single calls.
- Ordered multi-step work: batch-document-operations with [{ action: "create", ... }, { action: "updateEmbedded", ... }].
- refs accept { uuid } (best), { documentType, id }, or { documentType, name } (must be unambiguous).
- Big compendium entries: get-compendium-entry-full with fields: ["name","system.abilities","items"] to avoid huge payloads.
- Precise compendium queries: search-compendium-contents with filters like { path: "system.level", op: "lte", value: 3 } and documentType "Item".`,

  'multi-server': `# Working with multiple Foundry servers

- list-foundry-servers shows profiles, connection state, and which world each connection reports.
- use-foundry-server { name } switches ALL subsequent calls.
- One-off override without switching: add server: "<profile>" to ANY tool call's arguments.
- Stuck connection? reconnect-foundry-server restarts the listener; the module retries within ~30s.
- Edited foundry-servers.json? reload-foundry-servers-config applies it without restarting the MCP server.`,

  'script-execution': `# Script execution guidance

- execute-foundry-script runs JavaScript in the GM browser with full API access. Use for anything the typed tools do not cover.
- Return plain JSON-serializable values; use "return" (script mode) for results.
- Scripts are audited (hash + preview). Keep them idempotent when possible.
- Prefer typed tools when they exist — they validate, audit richer detail, and support undo; scripts do not support undo.`,
};

export class RecipeTools {
  private logger: Logger;

  constructor({ logger }: RecipeToolsOptions) {
    this.logger = logger.child({ component: 'RecipeTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'get-bridge-recipes',
        description:
          'Get curated guidance for driving this bridge effectively: dnd5e NPC-building rules (derived DCs, CR/proficiency, spell preparation), document API patterns (dry-run, undo, batching), multi-server usage, and script execution. Call with no topic to list topics.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              enum: Object.keys(RECIPES),
              description: 'Recipe topic; omit to list available topics',
            },
          },
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    if (name !== 'get-bridge-recipes') {
      throw new Error(`Unknown recipe tool: ${name}`);
    }
    const topic = typeof args?.topic === 'string' ? args.topic : undefined;
    if (!topic) {
      return {
        topics: Object.keys(RECIPES),
        hint: 'Call again with a topic to get the full recipe.',
      };
    }
    const recipe = RECIPES[topic];
    if (!recipe) {
      throw new Error(`Unknown topic "${topic}". Available: ${Object.keys(RECIPES).join(', ')}`);
    }
    this.logger.info('Recipe served', { topic });
    return { topic, recipe };
  }
}
