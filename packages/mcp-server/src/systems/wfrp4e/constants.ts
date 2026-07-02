/**
 * WFRP4e Constants
 *
 * Central definitions for the Warhammer Fantasy Roleplay 4th Edition system:
 * characteristic names, field paths, size mappings, and type maps.
 *
 * Data model reference (DataModel-based system):
 * https://github.com/moo-man/WFRP4e-FoundryVTT/tree/master/src/model/actor
 */

/**
 * The 10 WFRP4e characteristics (abbreviation -> full name).
 * Keys match `system.characteristics.<key>`.
 */
export const CHARACTERISTIC_NAMES: Record<string, { short: string; name: string }> = {
  ws: { short: 'WS', name: 'Weapon Skill' },
  bs: { short: 'BS', name: 'Ballistic Skill' },
  s: { short: 'S', name: 'Strength' },
  t: { short: 'T', name: 'Toughness' },
  i: { short: 'I', name: 'Initiative' },
  ag: { short: 'Ag', name: 'Agility' },
  dex: { short: 'Dex', name: 'Dexterity' },
  int: { short: 'Int', name: 'Intelligence' },
  wp: { short: 'WP', name: 'Willpower' },
  fel: { short: 'Fel', name: 'Fellowship' },
};

/**
 * Ordered list of characteristic keys (book order).
 */
export const CHARACTERISTIC_ORDER = [
  'ws',
  'bs',
  's',
  't',
  'i',
  'ag',
  'dex',
  'int',
  'wp',
  'fel',
] as const;

/**
 * WFRP4e size keys (game.wfrp4e.config.actorSizes) -> English label.
 */
export const SIZE_MAP: Record<string, string> = {
  tiny: 'tiny',
  ltl: 'little',
  sml: 'small',
  avg: 'average',
  lrg: 'large',
  enor: 'enormous',
  mnst: 'monstrous',
};

/**
 * Common WFRP4e field paths for system data access.
 */
export const FIELD_PATHS = {
  // Characteristics
  CHARACTERISTICS: 'system.characteristics',

  // Status / resources
  STATUS_WOUNDS: 'system.status.wounds',
  STATUS_ADVANTAGE: 'system.status.advantage',
  STATUS_CRITICAL_WOUNDS: 'system.status.criticalWounds',
  STATUS_CORRUPTION: 'system.status.corruption',
  STATUS_ENCUMBRANCE: 'system.status.encumbrance',
  STATUS_ARMOUR: 'system.status.armour',

  // Character-only fortune/fate pools (value-only, no max)
  STATUS_FATE: 'system.status.fate.value',
  STATUS_FORTUNE: 'system.status.fortune.value',
  STATUS_RESILIENCE: 'system.status.resilience.value',
  STATUS_RESOLVE: 'system.status.resolve.value',

  // Details / profile
  DETAILS_SPECIES: 'system.details.species.value',
  DETAILS_SUBSPECIES: 'system.details.species.subspecies',
  DETAILS_CAREER: 'system.details.career.value',
  DETAILS_CLASS: 'system.details.class.value',
  DETAILS_STATUS: 'system.details.status',
  DETAILS_MOVE: 'system.details.move.value',
  DETAILS_SIZE: 'system.details.size.value',
  DETAILS_EXPERIENCE: 'system.details.experience',
} as const;

/**
 * Item types in WFRP4e.
 */
export const ITEM_TYPES = {
  SKILL: 'skill',
  TALENT: 'talent',
  TRAIT: 'trait',
  CAREER: 'career',
  SPELL: 'spell', // Arcane magic (grouped by lore)
  PRAYER: 'prayer', // Divine magic (grouped by god)
  WEAPON: 'weapon',
  ARMOUR: 'armour',
  TRAPPING: 'trapping',
  AMMUNITION: 'ammunition',
  CONTAINER: 'container',
  MONEY: 'money',
  PSYCHOLOGY: 'psychology',
  DISEASE: 'disease',
  INJURY: 'injury',
  CRITICAL: 'critical',
  MUTATION: 'mutation',
  DISORDER: 'disorder',
} as const;

/**
 * Actor types in WFRP4e.
 */
export const ACTOR_TYPES = {
  CHARACTER: 'character', // Player characters
  NPC: 'npc', // Non-player characters
  CREATURE: 'creature', // Monsters / beasts
  VEHICLE: 'vehicle', // Vehicles
} as const;

/**
 * Normalize a raw WFRP4e size key to an English label.
 */
export function normalizeSize(size: unknown): string | undefined {
  if (typeof size !== 'string' || size.length === 0) {
    return undefined;
  }
  return SIZE_MAP[size.toLowerCase()] ?? size;
}
