/**
 * Cosmere RPG Filter Schema
 *
 * Filters for `search-compendium` and `list-creatures-by-criteria`.
 *
 * Cosmere RPG uses tiers (1-4) and adversary roles (minion/rival/boss/…)
 * rather than CR or level, so the filter surface is intentionally distinct
 * from the dnd5e/pf2e schemas.
 */

import { z } from 'zod';
import type { CosmereRpgCreatureIndex } from '../types.js';

/** Range filter: either an exact value or an inclusive {min?, max?} window. */
const NumberRange = z.union([
  z.number(),
  z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .strict(),
]);

/**
 * Adversary role values seen in the official Stormlight compendia.
 * Treated as a free-form string downstream (system may add roles).
 */
export const COSMERE_ROLES = ['minion', 'rival', 'boss'] as const;
export type CosmereRole = (typeof COSMERE_ROLES)[number];

/**
 * Common cosmere creature types observed in compendium content.
 * Matched against `system.type.id` (lowercased).
 */
export const COSMERE_CREATURE_TYPES = [
  'humanoid',
  'animal',
  'spren',
  'parshendi',
  'singer',
  'voidbringer',
  'fabrial',
  'unknown',
] as const;
export type CosmereCreatureType = (typeof COSMERE_CREATURE_TYPES)[number];

export const COSMERE_SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;

export const CosmereRpgFiltersSchema = z
  .object({
    /** Tier filter — exact value or {min, max}. */
    tier: NumberRange.optional(),
    /** Adversary role (minion/rival/boss/…). Case-insensitive match. */
    role: z.string().min(1).optional(),
    /** Creature type — matches `system.type.id`. Case-insensitive. */
    creatureType: z.string().min(1).optional(),
    /** Size category. */
    size: z.enum(COSMERE_SIZES).optional(),
    /** Filter for Surge/Investiture-using adversaries. */
    hasInvestiture: z.boolean().optional(),
    /** Health max range. */
    health: NumberRange.optional(),
    /** Minimum defense thresholds — pass any subset. */
    defensesMin: z
      .object({
        phy: z.number().optional(),
        cog: z.number().optional(),
        spi: z.number().optional(),
      })
      .strict()
      .optional(),
    /** Minimum deflect rating. */
    deflectMin: z.number().optional(),
  })
  .strict();

export type CosmereRpgFilters = z.infer<typeof CosmereRpgFiltersSchema>;

type RangeInput = number | { min?: number | undefined; max?: number | undefined };

/** Resolve a NumberRange against a candidate value. */
function inRange(value: number | undefined, range: RangeInput): boolean {
  if (value === undefined) return false;
  if (typeof range === 'number') return value === range;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

export function matchesCosmereRpgFilters(
  creature: CosmereRpgCreatureIndex,
  filters: CosmereRpgFilters
): boolean {
  const data = creature.systemData ?? ({} as CosmereRpgCreatureIndex['systemData']);

  if (filters.tier !== undefined && !inRange(data.tier, filters.tier)) {
    return false;
  }
  if (filters.role !== undefined) {
    const role = (data.role ?? '').toLowerCase();
    if (role !== filters.role.toLowerCase()) return false;
  }
  if (filters.creatureType !== undefined) {
    const ct = (data.creatureType ?? '').toLowerCase();
    if (ct !== filters.creatureType.toLowerCase()) return false;
  }
  if (filters.size !== undefined) {
    const size = (data.size ?? '').toLowerCase();
    if (size !== filters.size) return false;
  }
  if (filters.hasInvestiture !== undefined) {
    const has = data.hasInvestiture ?? (data.investiture ?? 0) > 0;
    if (has !== filters.hasInvestiture) return false;
  }
  if (filters.health !== undefined && !inRange(data.health, filters.health)) {
    return false;
  }
  if (filters.defensesMin !== undefined) {
    const def = data.defenses ?? {};
    const { phy, cog, spi } = filters.defensesMin;
    if (phy !== undefined && (def.phy ?? -Infinity) < phy) return false;
    if (cog !== undefined && (def.cog ?? -Infinity) < cog) return false;
    if (spi !== undefined && (def.spi ?? -Infinity) < spi) return false;
  }
  if (filters.deflectMin !== undefined) {
    if ((data.deflect ?? -Infinity) < filters.deflectMin) return false;
  }
  return true;
}

export function describeCosmereRpgFilters(filters: CosmereRpgFilters): string {
  const parts: string[] = [];

  if (filters.tier !== undefined) {
    parts.push(
      typeof filters.tier === 'number'
        ? `tier ${filters.tier}`
        : describeRange('tier', filters.tier)
    );
  }
  if (filters.role) parts.push(`role=${filters.role.toLowerCase()}`);
  if (filters.creatureType) parts.push(`type=${filters.creatureType.toLowerCase()}`);
  if (filters.size) parts.push(`size=${filters.size}`);
  if (filters.hasInvestiture !== undefined) {
    parts.push(filters.hasInvestiture ? 'has Investiture' : 'no Investiture');
  }
  if (filters.health !== undefined) {
    parts.push(
      typeof filters.health === 'number'
        ? `hp=${filters.health}`
        : describeRange('hp', filters.health)
    );
  }
  if (filters.defensesMin) {
    const { phy, cog, spi } = filters.defensesMin;
    if (phy !== undefined) parts.push(`phy>=${phy}`);
    if (cog !== undefined) parts.push(`cog>=${cog}`);
    if (spi !== undefined) parts.push(`spi>=${spi}`);
  }
  if (filters.deflectMin !== undefined) parts.push(`deflect>=${filters.deflectMin}`);

  return parts.length > 0 ? parts.join(', ') : 'no filters';
}

function describeRange(
  label: string,
  range: { min?: number | undefined; max?: number | undefined }
): string {
  if (range.min !== undefined && range.max !== undefined)
    return `${label} ${range.min}-${range.max}`;
  if (range.min !== undefined) return `${label}>=${range.min}`;
  if (range.max !== undefined) return `${label}<=${range.max}`;
  return `${label} (any)`;
}
