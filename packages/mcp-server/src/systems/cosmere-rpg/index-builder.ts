/**
 * Cosmere RPG Index Builder
 *
 * Builds the enhanced creature index from Foundry compendium packs.
 *
 * Runs in Foundry's browser context (foundry-module side); does NOT execute
 * on the Node MCP server. Mirrors the dnd5e/pf2e/dsa5 IndexBuilder pattern.
 *
 * Schema reference: github.com/the-metalworks/cosmere-rpg
 *   - Adversary actors expose `system.tier`, `system.role`, defenses,
 *     resources, etc. — see ../filters.ts for the indexed field list.
 *
 * Note: today the foundry-module's data-access.ts contains a parallel
 * inline extractor that's the actual runtime path. This file mirrors that
 * behavior so the two paths produce equivalent shapes if the registry is
 * ever wired up — same tech-debt situation as dnd5e/pf2e.
 */

import type { IndexBuilder, CosmereRpgCreatureIndex } from '../types.js';
import { readDerived } from './constants.js';

declare const ui: any;

interface CosmereExtractionResult {
  creature: CosmereRpgCreatureIndex;
  errors: number;
}

export class CosmereRpgIndexBuilder implements IndexBuilder {
  private moduleId: string;

  constructor(moduleId: string = 'foundry-mcp-bridge') {
    this.moduleId = moduleId;
  }

  getSystemId() {
    return 'cosmere-rpg' as const;
  }

  async buildIndex(packs: any[], _force = false): Promise<CosmereRpgCreatureIndex[]> {
    const startTime = Date.now();
    let progressNotification: any = null;
    let totalErrors = 0;

    try {
      const actorPacks = packs.filter(pack => pack.metadata.type === 'Actor');
      const enhancedCreatures: CosmereRpgCreatureIndex[] = [];

      console.log(
        `[${this.moduleId}] Starting Cosmere RPG creature index build from ${actorPacks.length} packs...`
      );
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.info(
          `Starting Cosmere RPG creature index build from ${actorPacks.length} packs...`
        );
      }

      for (let i = 0; i < actorPacks.length; i++) {
        const pack = actorPacks[i];
        const progressPercent = Math.round((i / actorPacks.length) * 100);

        if (i % 3 === 0 || pack.metadata.label.toLowerCase().includes('adversar')) {
          if (progressNotification && typeof ui !== 'undefined') {
            progressNotification.remove();
          }
          if (typeof ui !== 'undefined' && ui.notifications) {
            progressNotification = ui.notifications.info(
              `Building creature index... ${progressPercent}% (${i + 1}/${actorPacks.length}) Processing: ${pack.metadata.label}`
            );
          }
        }

        try {
          if (!pack.indexed) {
            await pack.getIndex({});
          }

          const packResult = await this.extractDataFromPack(pack);
          enhancedCreatures.push(...packResult.creatures);
          totalErrors += packResult.errors;

          if (i === 0 || (i + 1) % 5 === 0 || i === actorPacks.length - 1) {
            const totalCreaturesSoFar = enhancedCreatures.length;
            if (progressNotification && typeof ui !== 'undefined') {
              progressNotification.remove();
            }
            if (typeof ui !== 'undefined' && ui.notifications) {
              progressNotification = ui.notifications.info(
                `Index Progress: ${i + 1}/${actorPacks.length} packs complete, ${totalCreaturesSoFar} creatures indexed`
              );
            }
          }
        } catch (error) {
          console.warn(`[${this.moduleId}] Failed to process pack ${pack.metadata.label}:`, error);
          if (typeof ui !== 'undefined' && ui.notifications) {
            ui.notifications.warn(
              `Warning: Failed to index pack "${pack.metadata.label}" - continuing with other packs`
            );
          }
        }
      }

      if (progressNotification && typeof ui !== 'undefined') {
        progressNotification.remove();
      }

      const buildTimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const errorText = totalErrors > 0 ? ` (${totalErrors} extraction errors)` : '';
      const successMessage = `Cosmere RPG creature index complete! ${enhancedCreatures.length} creatures indexed from ${actorPacks.length} packs in ${buildTimeSeconds}s${errorText}`;

      console.log(`[${this.moduleId}] ${successMessage}`);
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.info(successMessage);
      }

      return enhancedCreatures;
    } catch (error) {
      if (progressNotification && typeof ui !== 'undefined') {
        progressNotification.remove();
      }

      const errorMessage = `Failed to build Cosmere RPG creature index: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;
      console.error(`[${this.moduleId}] ${errorMessage}`);
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.error(errorMessage);
      }
      throw error;
    }
  }

  async extractDataFromPack(
    pack: any
  ): Promise<{ creatures: CosmereRpgCreatureIndex[]; errors: number }> {
    const creatures: CosmereRpgCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();

      for (const doc of documents) {
        try {
          // Cosmere-rpg compendium creatures are `adversary`-typed. Player
          // characters (`character`) are excluded from the creature index
          // — they're individual sheets, not encounter material.
          if (doc.type !== 'adversary') {
            continue;
          }

          const result = this.extractCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract Cosmere RPG data from ${doc.name} in ${pack.metadata.label}:`,
            error
          );
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack.metadata.label}:`,
        error
      );
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Extract a single Cosmere RPG creature.
   *
   * Reads the live (post-derive) `doc.system` block. DerivedValueField
   * fields (resources.*.max, defenses.*, deflect, movement.*.rate) are
   * resolved via `readDerived`, which honours `useOverride`.
   *
   * Defaults (tier=0, role='unknown', etc.) match the browser-side extractor
   * in foundry-module's data-access.ts so both paths produce equivalent
   * shapes. "0" / "unknown" mean "field not set on the actor"; consumers
   * filtering by tier/role typically use ranges that exclude these.
   */
  extractCreatureData(doc: any, pack: any): CosmereExtractionResult | null {
    try {
      const system = doc.system ?? {};

      const tier = typeof system.tier === 'number' ? system.tier : 0;
      const level = typeof system.level === 'number' ? system.level : undefined;

      const role =
        typeof system.role === 'string' && system.role.length > 0
          ? system.role.toLowerCase()
          : 'unknown';

      const size =
        typeof system.size === 'string' && system.size.length > 0
          ? system.size.toLowerCase()
          : 'medium';

      const creatureType =
        typeof system.type?.id === 'string' && system.type.id.length > 0
          ? system.type.id.toLowerCase()
          : 'unknown';

      const subtype =
        typeof system.type?.subtype === 'string' && system.type.subtype.length > 0
          ? system.type.subtype
          : '';

      const health = readDerived(system.resources?.hea?.max) ?? 0;
      const focus = readDerived(system.resources?.foc?.max) ?? 0;
      const investiture = readDerived(system.resources?.inv?.max) ?? 0;

      const defenses = {
        phy: readDerived(system.defenses?.phy) ?? 0,
        cog: readDerived(system.defenses?.cog) ?? 0,
        spi: readDerived(system.defenses?.spi) ?? 0,
      };

      const deflect = readDerived(system.deflect) ?? 0;
      const walkSpeed = readDerived(system.movement?.walk?.rate) ?? 0;

      const systemData: CosmereRpgCreatureIndex['systemData'] = {
        tier,
        role,
        size,
        creatureType,
        subtype,
        health,
        focus,
        investiture,
        hasInvestiture: investiture > 0,
        defenses,
        deflect,
        walkSpeed,
      };
      if (level !== undefined) systemData.level = level;

      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          packName: pack.metadata.id,
          packLabel: pack.metadata.label,
          img: doc.img,
          system: 'cosmere-rpg',
          systemData,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to extract Cosmere RPG data from ${doc.name}:`,
        error
      );

      // Minimal fallback so the index isn't gappy on a single bad doc.
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          packName: pack.metadata.id,
          packLabel: pack.metadata.label,
          img: doc.img,
          system: 'cosmere-rpg',
          systemData: {
            tier: 0,
            role: 'unknown',
            size: 'medium',
            creatureType: 'unknown',
            subtype: '',
            health: 0,
            focus: 0,
            investiture: 0,
            hasInvestiture: false,
            defenses: { phy: 0, cog: 0, spi: 0 },
            deflect: 0,
            walkSpeed: 0,
          },
        },
        errors: 1,
      };
    }
  }
}
