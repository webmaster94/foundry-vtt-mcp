/**
 * DSA5 System Adapter
 *
 * Implements character-stat extraction for DSA5 (Das Schwarze Auge 5).
 */

import type { SystemAdapter, SystemMetadata } from '../types.js';
import { getExperienceLevel, EIGENSCHAFT_NAMES } from './constants.js';

/** DSA5 system adapter. */
export class DSA5Adapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'dsa5',
      name: 'dsa5',
      displayName: 'Das Schwarze Auge 5',
      version: '1.0.0',
      description:
        'Character support for DSA5 with Eigenschaften, Talente, Erfahrungsgrade, and LeP/AsP/KaP resources',
      supportedFeatures: {
        characterStats: true,
        spellcasting: true,
        powerLevel: true,
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'dsa5';
  }

  /**
   * Extract character statistics from actor data
   */
  extractCharacterStats(actorData: any): any {
    const system = actorData.system || {};
    const stats: any = {};

    // Basic info
    stats.name = actorData.name;
    stats.type = actorData.type;

    // Experience and Level
    const totalAP = system.details?.experience?.total ?? 0;
    const spentAP = system.details?.experience?.spent ?? 0;

    if (totalAP > 0) {
      const expLevel = getExperienceLevel(totalAP);
      stats.experience = {
        total: totalAP,
        spent: spentAP,
        available: totalAP - spentAP,
        level: expLevel.level,
        levelName: expLevel.name,
        levelNameEn: expLevel.nameEn,
      };
    }

    // LeP (Lebensenergie) - wounds.current contains actual current LeP
    const wounds = system.status?.wounds;
    if (wounds) {
      stats.lifePoints = {
        current: wounds.current ?? 0,
        max: wounds.max ?? 0,
      };
    }

    // AsP (Astralenergie)
    const astral = system.status?.astralenergy;
    if (astral && astral.max > 0) {
      stats.astralEnergy = {
        current: astral.value ?? 0,
        max: astral.max ?? 0,
      };
    }

    // KaP (Karmaenergie)
    const karma = system.status?.karmaenergy;
    if (karma && karma.max > 0) {
      stats.karmaEnergy = {
        current: karma.value ?? 0,
        max: karma.max ?? 0,
      };
    }

    // Eigenschaften (Characteristics: MU, KL, IN, CH, FF, GE, KO, KK)
    if (system.characteristics) {
      stats.characteristics = {};
      for (const [key, eigenschaft] of Object.entries(system.characteristics)) {
        const eigenschaftData = eigenschaft as any;
        const upperKey = key.toUpperCase();
        stats.characteristics[upperKey] = {
          value: eigenschaftData.value ?? 8,
          initial: eigenschaftData.initial ?? 8,
          name: EIGENSCHAFT_NAMES[upperKey]?.german,
          nameEn: EIGENSCHAFT_NAMES[upperKey]?.english,
        };
      }
    }

    // Combat values
    const initiative = system.status?.initiative?.value ?? system.status?.initiative;
    if (initiative !== undefined) {
      stats.initiative = initiative;
    }

    const speed = system.status?.speed?.value ?? system.status?.speed;
    if (speed !== undefined) {
      stats.speed = speed;
    }

    const dodge = system.status?.dodge?.value ?? system.status?.dodge;
    if (dodge !== undefined) {
      stats.dodge = dodge;
    }

    const armor = system.status?.armour?.value ?? system.status?.armor?.value ?? 0;
    if (armor) {
      stats.armor = armor;
    }

    // Identity info
    if (system.details) {
      const identity: any = {};

      const species = system.details.species?.value;
      if (species) {
        identity.species = species;
      }

      const culture = system.details.culture?.value;
      if (culture) {
        identity.culture = culture;
      }

      const career = system.details.career?.value;
      if (career) {
        identity.profession = career;
      }

      if (Object.keys(identity).length > 0) {
        stats.identity = identity;
      }
    }

    // Size
    const size = system.status?.size?.value;
    if (size) {
      stats.size = size;
    }

    // Tradition (magical/clerical)
    if (system.tradition) {
      const tradition: any = {};

      if (system.tradition.magical) {
        tradition.magical = system.tradition.magical;
      }

      if (system.tradition.clerical) {
        tradition.clerical = system.tradition.clerical;
      }

      if (Object.keys(tradition).length > 0) {
        stats.tradition = tradition;
      }
    }

    // Spellcasting detection
    const hasSpells = !!(astral?.max || karma?.max || system.tradition);
    if (hasSpells) {
      stats.spellcasting = {
        hasSpells: true,
        hasAstralEnergy: !!astral?.max,
        hasKarmaEnergy: !!karma?.max,
      };
    }

    return stats;
  }
}
