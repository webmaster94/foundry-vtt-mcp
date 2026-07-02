/**
 * WFRP4e System Module
 *
 * Exports for Warhammer Fantasy Roleplay 4th Edition support in the Registry
 * Pattern architecture.
 */

// Type definitions (from central types.ts)
export type { WFRP4eCreatureIndex } from '../types.js';

// System adapter (runs in MCP server Node.js context)
export { WFRP4eAdapter } from './adapter.js';

// Index builder (runs in Foundry browser context)
export { WFRP4eIndexBuilder } from './index-builder.js';

// Filter system
export {
  CreatureSizes,
  WFRP4eFiltersSchema,
  matchesWFRP4eFilters,
  describeWFRP4eFilters,
} from './filters.js';
export type { CreatureSize, WFRP4eFilters } from './filters.js';

// Constants
export {
  CHARACTERISTIC_NAMES,
  CHARACTERISTIC_ORDER,
  SIZE_MAP,
  FIELD_PATHS,
  ITEM_TYPES,
  ACTOR_TYPES,
  normalizeSize,
} from './constants.js';
