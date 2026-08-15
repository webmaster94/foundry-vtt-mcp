/**
 * D&D 5e System Adapter
 *
 * Implements character-stat extraction for D&D 5th Edition.
 */

import type { SystemAdapter, SystemMetadata } from '../types.js';

/**
 * D&D 5e system adapter
 */
export class DnD5eAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'dnd5e',
      name: 'dnd5e',
      displayName: 'Dungeons & Dragons 5th Edition',
      version: '1.0.0',
      description:
        'Character support for D&D 5e, including abilities, skills, spellcasting, and NPC statistics',
      supportedFeatures: {
        characterStats: true,
        spellcasting: true,
        powerLevel: true, // Uses Challenge Rating
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'dnd5e';
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

    // Challenge Rating or Level
    const cr = system.details?.cr ?? system.details?.cr?.value ?? system.cr;
    if (cr !== undefined && cr !== null) {
      stats.challengeRating = Number(cr);
    }

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
          value: abilityData.value ?? 10,
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
          value: skillData.value ?? 0,
          modifier: skillData.total ?? skillData.mod ?? 0,
          proficient: skillData.proficient ?? 0,
        };
      }
    }

    // Creature-specific info
    if (actorData.type === 'npc') {
      const creatureType = system.details?.type?.value ?? system.details?.type;
      if (creatureType) {
        stats.creatureType = creatureType;
      }

      const size = system.traits?.size?.value ?? system.traits?.size ?? system.size;
      if (size) {
        stats.size = size;
      }

      const alignment = system.details?.alignment?.value ?? system.details?.alignment;
      if (alignment) {
        stats.alignment = alignment;
      }

      // Legendary actions
      const legact = system.resources?.legact;
      if (legact) {
        stats.legendaryActions = {
          available: legact.value ?? 0,
          max: legact.max ?? 0,
        };
      }
    }

    // Spellcasting
    const hasSpells = !!(
      system.spells ||
      system.attributes?.spellcasting ||
      (system.details?.spellLevel && system.details.spellLevel > 0)
    );
    if (hasSpells) {
      stats.spellcasting = {
        hasSpells: true,
        spellLevel: system.details?.spellLevel ?? 0,
      };
    }

    return stats;
  }
}
