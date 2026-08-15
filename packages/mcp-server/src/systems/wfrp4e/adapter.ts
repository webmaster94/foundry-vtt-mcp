/**
 * WFRP4e System Adapter
 *
 * Character-focused support for Warhammer Fantasy Roleplay 4e.
 */

import type { SystemAdapter, SystemMetadata } from '../types.js';
import { CHARACTERISTIC_NAMES, normalizeSize } from './constants.js';

export class WFRP4eAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'wfrp4e',
      name: 'wfrp4e',
      displayName: 'Warhammer Fantasy Roleplay 4e',
      version: '1.0.0',
      description:
        'Character support for WFRP4e, including characteristics, resources, career, species, and spellcasting',
      supportedFeatures: {
        characterStats: true,
        spellcasting: true,
        powerLevel: false,
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'wfrp4e';
  }

  /**
   * Extract character statistics from actor data.
   * Receives the full character object (system + items).
   */
  extractCharacterStats(actorData: any): any {
    const system = actorData.system || {};
    const stats: any = {};

    stats.name = actorData.name;
    stats.type = actorData.type;

    // Characteristics (WS/BS/S/T/I/Ag/Dex/Int/WP/Fel)
    if (system.characteristics) {
      stats.characteristics = {};
      for (const [key, raw] of Object.entries(system.characteristics)) {
        const char = raw as any;
        const value = this.characteristicValue(char);
        const meta = CHARACTERISTIC_NAMES[key];
        // Total = initial + advances + modifier; surface all four so it reconciles.
        stats.characteristics[meta?.short ?? key.toUpperCase()] = {
          value, // Total
          bonus: this.characteristicBonus(char, value),
          initial: char?.initial ?? 0,
          advances: char?.advances ?? 0,
          modifier: char?.modifier ?? 0,
          name: meta?.name,
        };
      }
    }

    // Wounds (HP equivalent)
    const wounds = system.status?.wounds;
    if (wounds) {
      stats.wounds = { value: wounds.value ?? 0, max: wounds.max ?? 0 };
    }

    // Advantage
    const advantage = system.status?.advantage;
    if (advantage) {
      stats.advantage = { value: advantage.value ?? 0, max: advantage.max ?? 0 };
    }

    // Fate & Fortune (permanent / spendable)
    const fate = system.status?.fate?.value;
    const fortune = system.status?.fortune?.value;
    if (fate !== undefined || fortune !== undefined) {
      stats.fate = { fate: fate ?? 0, fortune: fortune ?? 0 };
    }

    // Resilience & Resolve (permanent / spendable)
    const resilience = system.status?.resilience?.value;
    const resolve = system.status?.resolve?.value;
    if (resilience !== undefined || resolve !== undefined) {
      stats.resilience = { resilience: resilience ?? 0, resolve: resolve ?? 0 };
    }

    // Corruption & critical wounds
    const corruption = system.status?.corruption;
    if (corruption) {
      stats.corruption = { value: corruption.value ?? 0, max: corruption.max ?? 0 };
    }
    const criticalWounds = system.status?.criticalWounds;
    if (criticalWounds) {
      stats.criticalWounds = {
        value: criticalWounds.value ?? 0,
        max: criticalWounds.max ?? 0,
      };
    }

    // Movement
    const move = system.details?.move;
    if (move) {
      stats.movement = {
        value: move.value,
        ...(move.walk !== undefined && { walk: move.walk }),
        ...(move.run !== undefined && { run: move.run }),
      };
    }

    // Identity (species / subspecies / career / class / social status)
    const identity: any = {};
    const species = system.details?.species?.value;
    if (species) identity.species = species;
    const subspecies = system.details?.species?.subspecies;
    if (subspecies) identity.subspecies = subspecies;
    const career = this.currentCareer(actorData);
    if (career) identity.career = career;
    const klass = system.details?.class?.value;
    if (klass) identity.class = klass;
    const status = system.details?.status;
    const statusLabel = typeof status === 'string' ? status : status?.value || status?.standing;
    if (statusLabel) identity.status = statusLabel;
    if (Object.keys(identity).length > 0) stats.identity = identity;

    // Size
    const size = normalizeSize(system.details?.size?.value);
    if (size) stats.size = size;

    // Experience
    const experience = system.details?.experience;
    if (experience) {
      const total = experience.total ?? 0;
      const spent = experience.spent ?? 0;
      stats.experience = {
        total,
        spent,
        current: experience.current ?? total - spent,
      };
    }

    const items: any[] = Array.isArray(actorData.items) ? actorData.items : [];

    // Skill value is the linked characteristic + advances + modifier (per the
    // system's Skill computeOwned), not advances alone. Prefer the derived total.
    const skillItems = items.filter(i => i?.type === 'skill');
    if (skillItems.length > 0) {
      const chars = system.characteristics || {};
      stats.skills = skillItems
        .map(skill => {
          const sk = skill.system || {};
          const charKey: string | undefined = sk.characteristic?.value;
          const advances = sk.advances?.value ?? 0;
          const modifier = sk.modifier?.value ?? 0;
          const charValue =
            charKey && chars[charKey] ? this.characteristicValue(chars[charKey]) : 0;
          const total = sk.total?.value ?? charValue + advances + modifier;
          const entry: any = { name: skill.name, advances, total };
          if (charKey) {
            entry.characteristic = CHARACTERISTIC_NAMES[charKey]?.short ?? charKey.toUpperCase();
          }
          return entry;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    // Spellcasting detection (from items)
    const hasSpells = items.some(i => i?.type === 'spell');
    const hasPrayers = items.some(i => i?.type === 'prayer');
    if (hasSpells || hasPrayers) {
      stats.spellcasting = { hasSpells, hasPrayers };
    }

    return stats;
  }

  /**
   * Seed the get-character `basicInfo` block with WFRP4e-native fields.
   * Wounds stand in for hit points; WFRP4e has no single armour-class value.
   */
  extractBasicInfo(actorData: any): any {
    const system = actorData.system || {};
    const basicInfo: any = {};

    const wounds = system.status?.wounds;
    if (wounds) {
      basicInfo.hitPoints = { current: wounds.value ?? 0, max: wounds.max ?? 0 };
    }

    const move = system.details?.move?.value;
    if (move !== undefined) {
      basicInfo.movement = move;
    }

    return basicInfo;
  }

  /**
   * Derive a characteristic's total value. Prefers the system-derived `value`;
   * falls back to initial + modifier + advances for raw/source actor data.
   */
  private characteristicValue(char: any): number {
    if (typeof char?.value === 'number') {
      return char.value;
    }
    return (char?.initial ?? 0) + (char?.modifier ?? 0) + (char?.advances ?? 0);
  }

  /**
   * Derive a characteristic bonus (tens digit). Prefers system-derived `bonus`.
   */
  private characteristicBonus(char: any, value: number): number {
    if (typeof char?.bonus === 'number') {
      return char.bonus;
    }
    return Math.floor(value / 10) + (char?.bonusMod ?? 0);
  }

  /**
   * Resolve the current career name. Prefer the current career *item* (the one
   * flagged `system.current.value`) — `system.details.career` is unreliable in
   * derived data, where it becomes the circular-ref'd career item that the
   * browser sanitizes to the literal string "[Circular Reference]". Falls back
   * to `details.career.value` for source data.
   */
  private currentCareer(actorData: any): string | undefined {
    const items: any[] = Array.isArray(actorData.items) ? actorData.items : [];
    const currentCareerItem = items.find(i => i?.type === 'career' && i.system?.current?.value);
    if (currentCareerItem?.name) {
      return currentCareerItem.name;
    }

    const raw = actorData.system?.details?.career;
    const value = typeof raw === 'string' ? raw : raw?.value || raw?.name;
    if (typeof value === 'string' && value && value !== '[Circular Reference]') {
      return value;
    }
    return undefined;
  }
}
