/**
 * WFRP4e Index Builder
 *
 * Builds a basic creature index from Foundry compendiums. Runs in Foundry's
 * browser context (not Node.js).
 *
 * This adapter is character-focused, so the creature index is intentionally
 * lightweight (species, size, wounds, spellcaster flags). It follows the dsa5
 * IndexBuilder structure for consistency.
 */

import type { IndexBuilder, WFRP4eCreatureIndex } from '../types.js';
import { normalizeSize } from './constants.js';

// Foundry browser global (unavailable during Node.js TypeScript compilation)
declare const ui: any;

interface WFRP4eExtractionResult {
  creature: WFRP4eCreatureIndex;
  errors: number;
}

/**
 * WFRP4e implementation of IndexBuilder.
 */
export class WFRP4eIndexBuilder implements IndexBuilder {
  private moduleId: string;

  constructor(moduleId: string = 'foundry-mcp-bridge') {
    this.moduleId = moduleId;
  }

  getSystemId() {
    return 'wfrp4e' as const;
  }

  async buildIndex(packs: any[], _force = false): Promise<WFRP4eCreatureIndex[]> {
    const startTime = Date.now();
    let totalErrors = 0;

    const actorPacks = packs.filter(pack => pack.metadata.type === 'Actor');
    const creatures: WFRP4eCreatureIndex[] = [];

    console.log(
      `[${this.moduleId}] Building WFRP4e creature index from ${actorPacks.length} packs...`
    );

    for (const pack of actorPacks) {
      try {
        if (!pack.indexed) {
          await pack.getIndex({});
        }
        const packResult = await this.extractDataFromPack(pack);
        creatures.push(...packResult.creatures);
        totalErrors += packResult.errors;
      } catch (error) {
        console.warn(`[${this.moduleId}] Failed to process pack ${pack.metadata.label}:`, error);
        if (typeof ui !== 'undefined' && ui.notifications) {
          ui.notifications.warn(`Warning: failed to index "${pack.metadata.label}" - continuing`);
        }
      }
    }

    const seconds = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `[${this.moduleId}] WFRP4e creature index complete: ${creatures.length} creatures from ` +
        `${actorPacks.length} packs in ${seconds}s${
          totalErrors > 0 ? ` (${totalErrors} extraction errors)` : ''
        }`
    );

    return creatures;
  }

  async extractDataFromPack(
    pack: any
  ): Promise<{ creatures: WFRP4eCreatureIndex[]; errors: number }> {
    const creatures: WFRP4eCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();
      for (const doc of documents) {
        try {
          if (doc.type !== 'npc' && doc.type !== 'character' && doc.type !== 'creature') {
            continue;
          }
          const result = this.extractCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract WFRP4e data from ${doc.name} in ${pack.metadata.label}:`,
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

  extractCreatureData(doc: any, pack: any): WFRP4eExtractionResult | null {
    try {
      const system = doc.system || {};
      const items: any[] = Array.from(doc.items?.values?.() ?? doc.items ?? []);

      const species =
        typeof system.details?.species?.value === 'string'
          ? system.details.species.value
          : undefined;
      const size = normalizeSize(system.details?.size?.value);
      const woundsRaw = system.status?.wounds?.max ?? system.status?.wounds?.value;
      const wounds = typeof woundsRaw === 'number' ? woundsRaw : undefined;

      const hasSpells = items.some(i => i?.type === 'spell');
      const hasPrayers = items.some(i => i?.type === 'prayer');
      const traits = items
        .filter(i => i?.type === 'trait')
        .map(i => i?.name)
        .filter((n): n is string => typeof n === 'string');

      // Build systemData omitting undefined keys (exactOptionalPropertyTypes).
      const systemData: WFRP4eCreatureIndex['systemData'] = { hasSpells, hasPrayers, traits };
      if (species !== undefined) systemData.species = species;
      if (size !== undefined) systemData.size = size;
      if (wounds !== undefined) systemData.wounds = wounds;

      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          packName: pack.metadata.id,
          packLabel: pack.metadata.label,
          img: doc.img,
          system: 'wfrp4e',
          systemData,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to extract WFRP4e data from ${doc.name}:`, error);
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          packName: pack.metadata.id,
          packLabel: pack.metadata.label,
          img: doc.img,
          system: 'wfrp4e',
          systemData: {
            hasSpells: false,
            hasPrayers: false,
            traits: [],
          },
        },
        errors: 1,
      };
    }
  }
}
