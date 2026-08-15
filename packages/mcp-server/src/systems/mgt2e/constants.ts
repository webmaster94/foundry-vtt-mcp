/**
 * Mongoose Traveller 2e Constants
 *
 * Field paths, characteristic names, skill list and actor types
 * for the mgt2e Foundry system (Mongoose Publishing).
 */

/**
 * Characteristic short codes → display names
 */
// Keys are lowercase — adapter normalises with key.toLowerCase() before lookup.
// This handles both mgt2e uppercase keys (STR, DEX…) and any lowercase variants.
// Source: MGT2.CHARACTERISTICS in config.mjs (show:true = standard; show:false = optional/variant)
export const CHARACTERISTIC_NAMES: Record<string, { short: string; full: string; show?: boolean }> =
  {
    // Standard characteristics (show: true by default)
    str: { short: 'STR', full: 'Strength', show: true },
    dex: { short: 'DEX', full: 'Dexterity', show: true },
    end: { short: 'END', full: 'Endurance', show: true },
    int: { short: 'INT', full: 'Intellect', show: true },
    edu: { short: 'EDU', full: 'Education', show: true },
    soc: { short: 'SOC', full: 'Social Standing', show: true },
    // Optional / variant characteristics (show: false — hidden unless enabled)
    cha: { short: 'CHA', full: 'Charisma' },
    ter: { short: 'TER', full: 'Terraforming' },
    psi: { short: 'PSI', full: 'Psionic Strength' },
    wlt: { short: 'WLT', full: 'Wealth' },
    lck: { short: 'LCK', full: 'Luck' },
    mrl: { short: 'MRL', full: 'Morale' },
    sty: { short: 'STY', full: 'Stability' },
    res: { short: 'RES', full: 'Resilience' },
    fol: { short: 'FOL', full: 'Followers' },
    rep: { short: 'REP', full: 'Reputation' },
  };

/**
 * Calculate the Dice Modifier (DM) for a characteristic value.
 * Matches the system's getModifier(): parseInt(value/3) - 2, with special cases for 0 and 1-2.
 * Table: 0=-3, 1-2=-2, 3-5=-1, 6-8=0, 9-11=+1, 12-14=+2, 15+=+3
 */
export function calcDM(value: number): number {
  if (value <= 0) return -3;
  if (value <= 2) return -2;
  return Math.min(3, Math.floor(value / 3) - 2);
}

/**
 * All skill keys used in the mgt2e system
 */
export const SKILL_KEYS = [
  'admin',
  'advocate',
  'animals',
  'art',
  'astrogation',
  'athletics',
  'broker',
  'carouse',
  'deception',
  'diplomat',
  'drive',
  'electronics',
  'engineer',
  'explosives',
  'flyer',
  'gambler',
  'gunner',
  'guncombat',
  'heavyweapons',
  'independence',
  'investigate',
  'jackofalltrades',
  'language',
  'leadership',
  'mechanic',
  'medic',
  'melee',
  'navigation',
  'persuade',
  'pilot',
  'profession',
  'recon',
  'science',
  'seafarer',
  'stealth',
  'steward',
  'streetwise',
  'survival',
  'tactics',
  'vaccsuit',
  'telepathy',
  'clairvoyance',
  'telekinesis',
  'awareness',
  'teleportation',
] as const;

/**
 * Actor types in the mgt2e system.
 * Source: template.json Actor.types
 */
export const ACTOR_TYPES = {
  TRAVELLER: 'traveller',
  NPC: 'npc',
  CREATURE: 'creature',
  SPACECRAFT: 'spacecraft',
  VEHICLE: 'vehicle',
  WORLD: 'world',
  PACKAGE: 'package',
  SWARM: 'swarm',
} as const;

/**
 * Item types in the mgt2e system.
 * Source: Foundry validation error listing valid types for system "mgt2e".
 */
export const ITEM_TYPES = {
  ITEM: 'item', // Generic item / behaviour / misc
  WEAPON: 'weapon',
  ARMOUR: 'armour',
  AUGMENT: 'augment', // Augmentation/cyberwear
  TERM: 'term', // Career term
  ASSOCIATE: 'associate', // Contact/ally/rival
  CARGO: 'cargo',
  HARDWARE: 'hardware', // Spacecraft hardware component
  ROLE: 'role', // Crew role
  SOFTWARE: 'software',
  WORLDDATA: 'worlddata', // World data
} as const;

/**
 * Field paths into actor.system for mgt2e actors
 */
export const FIELD_PATHS = {
  // Characteristics
  CHARACTERISTICS: 'system.characteristics',
  CHAR_STR: 'system.characteristics.str',
  CHAR_DEX: 'system.characteristics.dex',
  CHAR_END: 'system.characteristics.end',
  CHAR_INT: 'system.characteristics.int',
  CHAR_EDU: 'system.characteristics.edu',
  CHAR_SOC: 'system.characteristics.soc',
  CHAR_PSI: 'system.characteristics.psi',

  // Skills
  SKILLS: 'system.skills',

  // Hits / wounds
  HITS_VALUE: 'system.hits.value',
  HITS_MAX: 'system.hits.max',
  // Characteristic damage (traveller only — system.damage.STR/DEX/END.value)
  DAMAGE_STR: 'system.damage.STR.value',
  DAMAGE_DEX: 'system.damage.DEX.value',
  DAMAGE_END: 'system.damage.END.value',

  // Sophont details (traveller/npc) — stored under system.sophont, not system.details
  SOPHONT_SPECIES: 'system.sophont.species',
  SOPHONT_GENDER: 'system.sophont.gender',
  SOPHONT_AGE: 'system.sophont.age',
  SOPHONT_PROFESSION: 'system.sophont.profession',
  SOPHONT_HOMEWORLD: 'system.sophont.homeworld',

  // Spacecraft
  SHIP_HULL: 'system.hull',
  SHIP_DRIVE: 'system.drive',
} as const;
