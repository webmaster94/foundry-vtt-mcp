/**
 * Cosmere RPG System Adapter
 *
 * Character-oriented support for the Plotweaver Cosmere RPG system.
 */

import type { SystemAdapter, SystemMetadata } from '../types.js';
import {
  COSMERE_ATTR_KEYS,
  COSMERE_DEFENSE_KEYS,
  COSMERE_RESOURCES,
  readDerived,
} from './constants.js';

export class CosmereRpgAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'cosmere-rpg',
      name: 'cosmere-rpg',
      displayName: 'Cosmere RPG',
      version: '1.0.0',
      description:
        'Character support for the Cosmere RPG, including attributes, defenses, resources, deflect, and skills',
      supportedFeatures: {
        characterStats: true,
        spellcasting: false,
        powerLevel: true,
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'cosmere-rpg';
  }

  /**
   * Extract Cosmere-specific basic info: level, tier, resource maxes,
   * deflect. Returned object is merged into the get-character response's
   * `basicInfo` block.
   */
  extractBasicInfo(actorData: any): any {
    const system = actorData?.system || {};
    const out: any = {};

    if (typeof system.level === 'number') out.level = system.level;
    if (typeof system.tier === 'number') out.tier = system.tier;

    if (system.resources) {
      for (const [key, name] of Object.entries(COSMERE_RESOURCES)) {
        const r = system.resources[key];
        if (r) {
          out[name] = {
            current: typeof r.value === 'number' ? r.value : 0,
            max: readDerived(r.max) ?? 0,
            bonus: typeof r.bonus === 'number' ? r.bonus : 0,
          };
        }
      }
    }

    const deflect = readDerived(system.deflect);
    if (deflect !== undefined) out.deflect = deflect;

    return out;
  }

  /**
   * Extract Cosmere-specific stats: attributes (with pre→prs remap),
   * defenses (final values), skills (rank + mod).
   */
  extractCharacterStats(actorData: any): any {
    const system = actorData?.system || {};
    const stats: any = {};

    if (system.attributes) {
      stats.attributes = {};
      for (const key of COSMERE_ATTR_KEYS) {
        const a = system.attributes[key];
        if (a && typeof a.value === 'number') {
          stats.attributes[key] = a.value;
        }
      }
    }

    if (system.defenses) {
      stats.defenses = {};
      for (const key of COSMERE_DEFENSE_KEYS) {
        const v = readDerived(system.defenses[key]);
        if (v !== undefined) stats.defenses[key] = v;
      }
    }

    if (system.skills) {
      stats.skills = {};
      for (const [key, skill] of Object.entries(system.skills)) {
        if (typeof skill === 'object' && skill !== null) {
          const rank = (skill as any).rank;
          const mod = readDerived((skill as any).mod);
          stats.skills[key] = {
            rank: typeof rank === 'number' ? rank : 0,
            mod: mod ?? 0,
          };
        }
      }
    }

    return stats;
  }
}
