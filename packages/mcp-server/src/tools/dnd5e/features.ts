import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { detectGameSystem, getCachedSystemId } from '../../utils/system-detection.js';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5eFeaturesFromCompendiumToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5eFeaturesFromCompendiumTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: DnD5eFeaturesFromCompendiumToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DnD5eFeaturesFromCompendiumTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    return [
      {
        name: 'dnd5e-add-features-from-compendium',
        description:
          '[D&D 5e only] Import class features and monster features from an official compendium ' +
          'pack onto an actor (NPC or PC). Each feature is looked up by EXACT name ' +
          '(case-insensitive) and embedded onto the actor as-is from the compendium data.\n\n' +
          'USE THIS TOOL when you need to:\n' +
          '  - Add monster features by name (e.g. "Pack Tactics", "Nimble Escape", "Multiattack")\n' +
          '  - Add class features to an NPC caster (e.g. "Spellcasting", "Action Surge", "Font of Magic")\n' +
          '  - Mix features from monster and class compendiums on a custom NPC\n' +
          '  - Example: "add Spellcasting, Font of Magic and Metamagic to this sorcerer NPC"\n\n' +
          '⚠️ IMPORTANT — feature names must be in English: the compendium uses English names. ' +
          'Translate BEFORE calling if the user provided names in another language.\n\n' +
          'compendiumPacks controls which pack(s) to search (priority order, first match wins):\n' +
          '  - Default ["dnd5e.monsterfeatures", "dnd5e.classfeatures"] → 2014 SRD\n' +
          '  - ["dnd5e.monsterfeatures24"]                              → 2024 monster features only\n' +
          '  - ["dnd5e.monsterfeatures24", "dnd5e.classfeatures"]       → 2024 monsters + 2014 class\n\n' +
          'DO NOT USE THIS TOOL for:\n' +
          '  - Importing spell items → use dnd5e-add-spells-to-actor instead\n' +
          '  - Setting up spellcasting class or spell slots → use dnd5e-set-actor-spellcasting\n' +
          '  - Importing 2024 class features — they are embedded inside class items in the 2024 ' +
          'edition, not available in a separate compendium pack; this tool cannot import them\n' +
          '  - Creating custom/homebrew features from scratch → compendium-only, no homebrew\n' +
          '  - Non-dnd5e systems → this tool is dnd5e-exclusive\n\n' +
          'Returns a detailed report: features added ✅, skipped (already on actor) ⏭️, ' +
          'not found in compendium ❌, and failed during import ⚠️.\n' +
          'Use list-characters or get-character first to find the actorIdentifier.',
        inputSchema: {
          type: 'object',
          properties: {
            actorIdentifier: {
              type: 'string',
              description: 'Name or ID of the target actor (partial name match supported)',
            },
            featureNames: {
              type: 'array',
              description:
                'English feature names to import (exact match, case-insensitive). ' +
                'Maximum 50 per call.',
              minItems: 1,
              maxItems: 50,
              items: { type: 'string', minLength: 1 },
            },
            compendiumPacks: {
              type: 'array',
              description:
                'Compendium pack IDs to search, in priority order (first match wins). ' +
                'Defaults to ["dnd5e.monsterfeatures", "dnd5e.classfeatures"] (SRD 2014). ' +
                'Use "dnd5e.monsterfeatures24" for 2024 monster features. ' +
                'Note: 2024 class features are not available in a separate pack.',
              items: { type: 'string', minLength: 1 },
              default: ['dnd5e.monsterfeatures', 'dnd5e.classfeatures'],
            },
          },
          required: ['actorIdentifier', 'featureNames'],
        },
      },
    ];
  }

  async handleAddFeaturesFromCompendium(args: any): Promise<any> {
    const schema = z.object({
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      featureNames: z.array(z.string().min(1)).min(1).max(50),
      compendiumPacks: z
        .array(z.string().min(1))
        .default(['dnd5e.monsterfeatures', 'dnd5e.classfeatures']),
    });

    const parsed = schema.parse(args);

    this.logger.info('Adding features to D&D 5e actor from compendium', {
      actorIdentifier: parsed.actorIdentifier,
      featureCount: parsed.featureNames.length,
      packs: parsed.compendiumPacks,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-features-from-compendium requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query(
        'foundry-mcp-bridge.addFeaturesFromCompendium',
        parsed
      );

      this.logger.info('Features import complete', {
        actorId: result.actor?.id,
        added: result.added?.length,
        skipped: result.skipped?.length,
        notFound: result.notFound?.length,
        failed: result.failed?.length,
      });

      return this.formatResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(
        error,
        'dnd5e-add-features-from-compendium',
        'feature import'
      );
    }
  }

  private formatResponse(result: any, params: any): any {
    const added = result.added as Array<{
      name: string;
      packId: string;
      packLabel: string;
      itemId: string;
    }>;
    const skipped = result.skipped as Array<{ name: string; reason: string }>;
    const notFound = result.notFound as string[];
    const failed = result.failed as Array<{ name: string; error: string }>;
    const warnings = result.warnings as string[];

    const totalRequested = (params.featureNames as string[]).length;

    // ── Summary line ──────────────────────────────────────────────────────────
    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} added`);
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (notFound.length > 0) parts.push(`${notFound.length} not found`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);

    const statusIcon = failed.length > 0 ? '⚠️' : notFound.length > 0 ? '🔍' : '✅';
    const summary =
      `${statusIcon} Features imported to "${result.actor.name}" — ` +
      (parts.length > 0 ? parts.join(', ') : 'nothing changed');

    // ── Sections ──────────────────────────────────────────────────────────────
    const lines: string[] = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Requested:** ${totalRequested} — Added: ${added.length}, Skipped: ${skipped.length}, Not found: ${notFound.length}${failed.length > 0 ? `, Failed: ${failed.length}` : ''}`,
    ];

    if (added.length > 0) {
      lines.push('\n✅ **Added:**');
      for (const f of added) {
        lines.push(`  - ${f.name} *(${f.packLabel}, item \`${f.itemId}\`)*`);
      }
    }

    if (skipped.length > 0) {
      lines.push('\n⏭️ **Skipped:**');
      for (const f of skipped) {
        lines.push(`  - ${f.name} — *${f.reason}*`);
      }
    }

    if (notFound.length > 0) {
      lines.push('\n❌ **Not found in compendium:**');
      for (const name of notFound) {
        lines.push(`  - ${name}`);
      }
    }

    if (failed.length > 0) {
      lines.push('\n⚠️ **Failed during import:**');
      for (const f of failed) {
        lines.push(`  - ${f.name} — *${f.error}*`);
      }
    }

    if (warnings.length > 0) {
      lines.push(`\n⚠️ **Warnings:**`);
      for (const w of warnings) {
        lines.push(`  - ${w}`);
      }
    }

    return {
      summary,
      success: added.length > 0 || (notFound.length === 0 && failed.length === 0),
      actor: result.actor,
      added,
      skipped,
      notFound,
      failed,
      warnings,
      message: `${summary}\n\n${lines.join('\n')}`,
    };
  }
}
