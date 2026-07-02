/**
 * System Adapter Architecture - Core Types
 *
 * This file defines the interfaces for the Registry pattern that enables
 * extensible multi-system support without editing core files.
 */

import { z } from 'zod';

/**
 * Supported game system identifiers
 * Extend this type when adding new systems
 */
export type SystemId = 'dnd5e' | 'pf2e' | 'dsa5' | 'cosmere-rpg' | 'wfrp4e' | 'other';

/**
 * System metadata returned by adapters
 */
export interface SystemMetadata {
  id: SystemId;
  name: string;
  displayName: string;
  version: string;
  description: string;
  supportedFeatures: {
    creatureIndex: boolean;
    characterStats: boolean;
    spellcasting: boolean;
    powerLevel: boolean; // CR/Level/equivalent
  };
}

/**
 * Base interface for system-specific creature data
 * Each system extends this with their own fields
 */
export interface SystemCreatureIndex {
  // Common fields across all systems
  id: string;
  name: string;
  type: string; // Actor type from Foundry
  packName: string;
  packLabel: string;
  img?: string;

  // System-specific metadata
  system: SystemId;
  systemData: any; // System-specific fields (D&D 5e CR, PF2e level, etc.)
}

/**
 * System Adapter Interface
 *
 * Each game system implements this interface to provide system-specific
 * logic for creature indexing, filtering, formatting, and data extraction.
 */
export interface SystemAdapter {
  /**
   * Get system metadata
   */
  getMetadata(): SystemMetadata;

  /**
   * Check if this adapter can handle a given system ID
   * @param systemId - The Foundry system ID (e.g., "dnd5e", "pf2e", "dsa5")
   */
  canHandle(systemId: string): boolean;

  /**
   * Extract creature data from a Foundry document for indexing
   * Called during enhanced creature index building
   * @param doc - Foundry actor document
   * @param pack - Compendium pack metadata
   * @returns Creature data or null if not a valid creature
   */
  extractCreatureData(
    doc: any,
    pack: any
  ): { creature: SystemCreatureIndex; errors: number } | null;

  /**
   * Get Zod schema for filter validation
   * Used by search-compendium and list-creatures-by-criteria tools
   */
  getFilterSchema(): z.ZodSchema;

  /**
   * Check if a creature matches the given filters
   * @param creature - Indexed creature data
   * @param filters - User-provided filter criteria
   */
  matchesFilters(creature: SystemCreatureIndex, filters: Record<string, any>): boolean;

  /**
   * Get system-specific data paths for actor properties
   * Returns null for paths that don't exist in this system
   */
  getDataPaths(): Record<string, string | null>;

  /**
   * Format creature data for list display
   * Used in search results and creature lists
   */
  formatCreatureForList(creature: SystemCreatureIndex): any;

  /**
   * Format creature data for detailed display
   * Used when showing full creature information
   */
  formatCreatureForDetails(creature: SystemCreatureIndex): any;

  /**
   * Generate human-readable description of filters
   * @param filters - Filter criteria to describe
   */
  describeFilters(filters: Record<string, any>): string;

  /**
   * Get normalized power level for a creature
   * D&D 5e: CR (0-30)
   * PF2e: Level (-1 to 25+)
   * DSA5: Challenge Points or equivalent
   * @returns Numeric power level for comparison, or undefined if not applicable
   */
  getPowerLevel(creature: SystemCreatureIndex): number | undefined;

  /**
   * Extract character statistics from actor data
   * Used by get-character and list-characters tools
   * @param actorData - Raw Foundry actor data
   */
  extractCharacterStats(actorData: any): any;

  /**
   * Extract system-specific "basic info" from actor data
   * (e.g. resources/HP, AC, level, deflect — anything that belongs in
   * the top-level `basicInfo` block of the get-character response).
   *
   * Optional: if not implemented, the get-character tool falls back
   * to its built-in cross-system extractor (which works for dnd5e/pf2e).
   *
   * @param actorData - Raw Foundry actor data
   * @returns Object merged into the get-character response's basicInfo
   */
  extractBasicInfo?(actorData: any): any;
}

/**
 * Index Builder Interface
 *
 * Handles building the enhanced creature index in Foundry's browser context.
 * Separate from SystemAdapter because this runs in Foundry module (browser),
 * while SystemAdapter runs in MCP server (Node.js).
 */
export interface IndexBuilder {
  /**
   * Get the system ID this builder handles
   */
  getSystemId(): SystemId;

  /**
   * Build enhanced creature index from compendium packs
   * @param packs - Array of compendium packs to index
   * @param force - Force rebuild even if cache exists
   * @returns Array of indexed creatures
   */
  buildIndex(packs: any[], force?: boolean): Promise<SystemCreatureIndex[]>;

  /**
   * Extract creature data from a single compendium pack
   * @param pack - Compendium pack to process
   * @returns Creatures and error count
   */
  extractDataFromPack(pack: any): Promise<{ creatures: SystemCreatureIndex[]; errors: number }>;
}

/**
 * D&D 5e specific creature index structure
 */
export interface DnD5eCreatureIndex extends SystemCreatureIndex {
  system: 'dnd5e';
  systemData: {
    challengeRating?: number;
    creatureType?: string;
    size?: string;
    alignment?: string;
    level?: number;
    hasSpellcasting: boolean;
    hasLegendaryActions: boolean;
    hitPoints?: number;
    armorClass?: number;
  };
}

/**
 * Pathfinder 2e specific creature index structure
 */
export interface PF2eCreatureIndex extends SystemCreatureIndex {
  system: 'pf2e';
  systemData: {
    level?: number;
    traits?: string[];
    size?: string;
    alignment?: string;
    rarity?: string;
    hasSpellcasting: boolean;
    hitPoints?: number;
    armorClass?: number;
  };
}

/**
 * DSA5 (Das Schwarze Auge 5) specific creature index structure
 */
export interface DSA5CreatureIndex extends SystemCreatureIndex {
  system: 'dsa5';
  systemData: {
    level?: number; // Experience level 1-7
    species?: string; // Spezies (Human, Elf, Dwarf, etc.)
    culture?: string; // Kultur
    profession?: string; // Profession (career)
    size?: string; // Size category
    hasSpells: boolean; // Has spellcasting abilities
    hasAstralEnergy?: boolean; // Has AsP (Astralenergie)
    hasKarmaEnergy?: boolean; // Has KaP (Karmaenergie)
    traits?: string[]; // Special abilities/traits
    hitPoints?: number; // Deprecated, use lifePoints
    lifePoints?: number; // LeP (Lebensenergie)
    experiencePoints?: number; // Abenteuerpunkte (AP)
    meleeDefense?: number; // Parry defense (PAW)
    rangedDefense?: number; // Dodge defense (AW)
    armor?: number; // Armor rating (RS)
    rarity?: string; // Rarity classification
  };
}

/**
 * Cosmere RPG specific creature index structure
 *
 * Schema reference: github.com/the-metalworks/cosmere-rpg
 *
 * Most cosmere-rpg compendium creatures are `adversary`-type actors. The
 * fields below are extracted from the live (post-derive) `system.*` block
 * so DerivedValueField overrides (e.g. health max set via the sheet) are
 * resolved before indexing — see `readDerived` in ./cosmere-rpg/constants.ts.
 */
export interface CosmereRpgCreatureIndex extends SystemCreatureIndex {
  system: 'cosmere-rpg';
  systemData: {
    /** Player-character level (rare in compendium adversaries). */
    level?: number;
    /** Adversary tier — 1 (minion-tier) to 4 (legendary). Primary power-level proxy. */
    tier?: number;
    /** Adversary role — `minion` | `rival` | `boss` (and any system-defined extension). */
    role?: string;
    /** Size category (tiny/small/medium/large/huge/gargantuan). */
    size?: string;
    /** Primary creature type (`humanoid`, `animal`, `spren`, `parshendi`, ...). */
    creatureType?: string;
    /** Free-form subtype (e.g. specific singer form, beast variant). */
    subtype?: string;
    /** Health max (resources.hea.max, override-aware). */
    health?: number;
    /** Focus max (resources.foc.max, override-aware). */
    focus?: number;
    /** Investiture max (resources.inv.max, override-aware) — usually 0 for non-Surge-users. */
    investiture?: number;
    /** Convenience flag: `investiture > 0`. */
    hasInvestiture?: boolean;
    /** Final defense values (post-derive). */
    defenses?: {
      phy?: number;
      cog?: number;
      spi?: number;
    };
    /** Deflect rating. */
    deflect?: number;
    /** Walk speed in feet (movement.walk.rate, override-aware). */
    walkSpeed?: number;
  };
}

/**
 * WFRP4e (Warhammer Fantasy Roleplay 4e) specific creature index structure.
 *
 * Character-focused adapter: the creature index is intentionally lightweight
 * (WFRP4e has no Challenge Rating / level metric).
 */
export interface WFRP4eCreatureIndex extends SystemCreatureIndex {
  system: 'wfrp4e';
  systemData: {
    species?: string; // Species/race (Human, Beastman, Goblin, ...)
    size?: string; // Normalized size label
    wounds?: number; // Maximum wounds
    hasSpells: boolean; // Has arcane spell items
    hasPrayers: boolean; // Has divine prayer items
    traits?: string[]; // Creature trait item names
  };
}

/**
 * Generic creature index for unsupported systems
 */
export interface GenericCreatureIndex extends SystemCreatureIndex {
  system: 'other';
  systemData: Record<string, any>;
}

/**
 * Union type of all creature index types
 */
export type AnyCreatureIndex =
  | DnD5eCreatureIndex
  | PF2eCreatureIndex
  | DSA5CreatureIndex
  | CosmereRpgCreatureIndex
  | WFRP4eCreatureIndex
  | GenericCreatureIndex;
