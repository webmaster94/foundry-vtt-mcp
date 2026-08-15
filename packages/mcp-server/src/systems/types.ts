/**
 * System Adapter Architecture - Core Types
 *
 * System adapters provide character-oriented extraction for the MCP server.
 * Compendium search uses the generic filtering layer instead of maintaining a
 * persistent creature index.
 */

/** Supported game system identifiers. Extend when adding a system. */
export type SystemId = 'dnd5e' | 'pf2e' | 'dsa5' | 'cosmere-rpg' | 'wfrp4e' | 'mgt2e' | 'other';

/** System metadata returned by adapters. */
export interface SystemMetadata {
  id: SystemId;
  name: string;
  displayName: string;
  version: string;
  description: string;
  supportedFeatures: {
    characterStats: boolean;
    spellcasting: boolean;
    powerLevel: boolean;
  };
}

/** System-specific behavior used by character and actor tooling. */
export interface SystemAdapter {
  getMetadata(): SystemMetadata;
  canHandle(systemId: string): boolean;
  extractCharacterStats(actorData: any): any;

  /**
   * Extract system-specific fields for the top-level `basicInfo` block of a
   * get-character response. The character tool falls back to its generic
   * extractor when an adapter does not implement this method.
   */
  extractBasicInfo?(actorData: any): any;

  /** Return system-specific, read-only actor schema guidance. */
  describeActorSchema?(): string;

  /** Normalize system data before an existing audited write path receives it. */
  normalizePayload?(system: Record<string, any>): Record<string, any>;
}
