/**
 * WFRP4e Filter Schemas
 *
 * Minimal creature filters (species, size, spellcaster). WFRP4e has no
 * Challenge Rating / level metric, so filtering is intentionally lightweight.
 */

import { z } from 'zod';

/**
 * Creature sizes (English labels; see SIZE_MAP in constants.ts).
 */
export const CreatureSizes = [
  'tiny',
  'little',
  'small',
  'average',
  'large',
  'enormous',
  'monstrous',
] as const;
export type CreatureSize = (typeof CreatureSizes)[number];

/**
 * WFRP4e creature filter schema (permissive).
 */
export const WFRP4eFiltersSchema = z.object({
  // Species/race, free-form (e.g. "Human", "Beastman", "Goblin")
  species: z.string().optional(),

  // Size category
  size: z.enum(CreatureSizes).optional(),

  // Has arcane spells or divine prayers
  hasSpells: z.boolean().optional(),
});

export type WFRP4eFilters = z.infer<typeof WFRP4eFiltersSchema>;

/**
 * Check if a creature matches WFRP4e filters.
 */
export function matchesWFRP4eFilters(creature: any, filters: WFRP4eFilters): boolean {
  // Species filter
  if (filters.species) {
    const species = creature.systemData?.species;
    if (!species?.toLowerCase().includes(filters.species.toLowerCase())) {
      return false;
    }
  }

  // Size filter
  if (filters.size) {
    const size = creature.systemData?.size;
    if (!size || size.toLowerCase() !== filters.size.toLowerCase()) {
      return false;
    }
  }

  // Spellcaster filter
  if (filters.hasSpells !== undefined) {
    const hasSpells = creature.systemData?.hasSpells || false;
    if (hasSpells !== filters.hasSpells) {
      return false;
    }
  }

  return true;
}

/**
 * Generate a human-readable description of WFRP4e filters.
 */
export function describeWFRP4eFilters(filters: WFRP4eFilters): string {
  const parts: string[] = [];

  if (filters.species) parts.push(filters.species);
  if (filters.size) parts.push(filters.size);
  if (filters.hasSpells) parts.push('spellcaster');

  return parts.length > 0 ? parts.join(', ') : 'no filters';
}
