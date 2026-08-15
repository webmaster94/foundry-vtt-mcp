/**
 * Pathfinder 2e System Adapter
 *
 * Implements character-stat extraction for Pathfinder 2nd Edition.
 */

import type { SystemAdapter, SystemMetadata } from '../types.js';

/**
 * Pathfinder 2e system adapter
 */
export class PF2eAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'pf2e',
      name: 'pf2e',
      displayName: 'Pathfinder 2nd Edition',
      version: '1.0.0',
      description:
        'Character support for PF2e, including level, traits, skills, saves, and spellcasting',
      supportedFeatures: {
        characterStats: true,
        spellcasting: true,
        powerLevel: true, // Uses Level
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'pf2e';
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

    // Level
    const level = system.details?.level?.value ?? system.details?.level ?? system.level;
    if (level !== undefined && level !== null) {
      stats.level = Number(level);
    }

    // Hit Points
    const hp = system.attributes?.hp;
    if (hp) {
      stats.hitPoints = {
        current: hp.value ?? 0,
        max: hp.max ?? 0,
        temp: hp.temp ?? 0,
      };
    }

    // Armor Class
    const ac = system.attributes?.ac?.value ?? system.attributes?.ac;
    if (ac !== undefined) {
      stats.armorClass = ac;
    }

    // Abilities (STR, DEX, CON, INT, WIS, CHA)
    if (system.abilities) {
      stats.abilities = {};
      for (const [key, ability] of Object.entries(system.abilities)) {
        const abilityData = ability as any;
        stats.abilities[key] = {
          value: abilityData.value ?? abilityData.mod ?? 0,
          modifier: abilityData.mod ?? 0,
        };
      }
    }

    // Skills
    if (system.skills) {
      stats.skills = {};
      for (const [key, skill] of Object.entries(system.skills)) {
        const skillData = skill as any;
        stats.skills[key] = {
          modifier: skillData.value ?? skillData.mod ?? 0,
          rank: skillData.rank ?? 0,
          proficient: (skillData.rank ?? 0) > 0,
        };
      }
    }

    // Perception
    if (system.perception) {
      stats.perception = {
        modifier: system.perception.value ?? system.perception.mod ?? 0,
        rank: system.perception.rank ?? 0,
      };
    }

    // Saves
    if (system.saves) {
      stats.saves = {};
      for (const [key, save] of Object.entries(system.saves)) {
        const saveData = save as any;
        stats.saves[key] = {
          modifier: saveData.value ?? saveData.mod ?? 0,
          rank: saveData.rank ?? 0,
        };
      }
    }

    // Creature-specific info
    if (actorData.type === 'npc') {
      const traits = system.traits?.value || [];
      if (Array.isArray(traits) && traits.length > 0) {
        stats.traits = traits;

        // Extract primary creature type
        const creatureTraits = [
          'aberration',
          'animal',
          'beast',
          'celestial',
          'construct',
          'dragon',
          'elemental',
          'fey',
          'fiend',
          'fungus',
          'humanoid',
          'monitor',
          'ooze',
          'plant',
          'undead',
        ];
        const primaryType = traits.find((t: string) => creatureTraits.includes(t.toLowerCase()));
        if (primaryType) {
          stats.creatureType = primaryType;
        }
      }

      const size = system.traits?.size?.value ?? system.traits?.size;
      if (size) {
        stats.size = size;
      }

      const alignment = system.details?.alignment?.value ?? system.details?.alignment;
      if (alignment) {
        stats.alignment = alignment;
      }

      const rarity = system.traits?.rarity;
      if (rarity) {
        stats.rarity = rarity;
      }
    }

    // Spellcasting
    const spellcasting = system.spellcasting || {};
    const hasSpells = Object.keys(spellcasting).length > 0;
    if (hasSpells) {
      stats.spellcasting = {
        hasSpells: true,
        entries: Object.keys(spellcasting).length,
      };
    }

    return stats;
  }
}
