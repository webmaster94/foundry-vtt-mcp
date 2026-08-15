import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { SystemRegistry } from '../systems/system-registry.js';
import {
  detectGameSystem,
  getCreatureLevel,
  getCreatureType,
  type GameSystem,
} from '../utils/system-detection.js';
import {
  GenericFiltersSchema,
  describeFilters,
  type GenericFilters,
} from '../utils/compendium-filters.js';
import { readDerived } from '../systems/cosmere-rpg/constants.js';

export interface CompendiumToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
  systemRegistry?: SystemRegistry;
}

export class CompendiumTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private systemRegistry: SystemRegistry | null;

  constructor({ foundryClient, logger, systemRegistry }: CompendiumToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CompendiumTools' });
    this.systemRegistry = systemRegistry || null;
  }

  /** Detect the current routed world's system for this call. */
  private async getGameSystem(): Promise<GameSystem> {
    return detectGameSystem(this.foundryClient, this.logger);
  }

  /**
   * Tool definitions for compendium operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'search-compendium',
        description:
          'Search compendium packs by entry NAME only (descriptions are not searched; the filters are name-keyword heuristics). For real system-data filters such as spell level, item type, or challenge rating, use search-compendium-contents.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Broad name terms, e.g. "dragon", "sword"' },
            packType: { type: 'string', description: 'e.g. "Item", "Actor", "JournalEntry"' },
            filters: {
              type: 'object',
              description: 'Actor packs only; name-keyword heuristics, not system data',
              properties: {
                challengeRating: {
                  oneOf: [
                    { type: 'number' },
                    {
                      type: 'object',
                      properties: { min: { type: 'number' }, max: { type: 'number' } },
                    },
                  ],
                },
                creatureType: {
                  type: 'string',
                  enum: [
                    'humanoid',
                    'dragon',
                    'beast',
                    'undead',
                    'fey',
                    'fiend',
                    'celestial',
                    'construct',
                    'elemental',
                    'giant',
                    'monstrosity',
                    'ooze',
                    'plant',
                    'aberration',
                  ],
                },
                size: {
                  type: 'string',
                  enum: ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'],
                },
                alignment: { type: 'string' },
                hasLegendaryActions: { type: 'boolean' },
                spellcaster: { type: 'boolean' },
                level: {
                  description: 'PF2e level',
                  oneOf: [
                    { type: 'number' },
                    {
                      type: 'object',
                      properties: { min: { type: 'number' }, max: { type: 'number' } },
                    },
                  ],
                },
                traits: { type: 'array', items: { type: 'string' }, description: 'PF2e' },
                rarity: {
                  type: 'string',
                  enum: ['common', 'uncommon', 'rare', 'unique'],
                  description: 'PF2e',
                },
                hasSpells: { type: 'boolean', description: 'PF2e' },
              },
            },
            limit: { type: 'number', minimum: 1, maximum: 50 },
          },
          required: ['query'],
        },
      },
      {
        name: 'get-compendium-item',
        description:
          'Retrieve detailed information about a specific compendium item. Use compact mode for UI performance when full details are not needed.',
        inputSchema: {
          type: 'object',
          properties: {
            packId: {
              type: 'string',
              description: 'ID of the compendium pack containing the item',
            },
            itemId: {
              type: 'string',
              description: 'ID of the specific item to retrieve',
            },
            compact: {
              type: 'boolean',
              description:
                'Return condensed stat block (recommended for UI performance). Includes key stats, abilities, and actions but omits lengthy descriptions and technical data.',
              default: false,
            },
          },
          required: ['packId', 'itemId'],
        },
      },
      {
        name: 'list-compendium-packs',
        description: 'List all available compendium packs',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Optional filter by pack type',
            },
          },
        },
      },
    ];
  }

  async handleSearchCompendium(args: any): Promise<any> {
    // Detect game system for appropriate filtering
    const gameSystem = await this.getGameSystem();

    const schema = z.object({
      query: z.string().min(2, 'Search query must be at least 2 characters'),
      packType: z.string().optional(),
      filters: GenericFiltersSchema.optional(),
      limit: z.number().min(1).max(50).default(50),
    });

    // Add defensive parsing for MCP argument structure inconsistencies
    let parsedArgs;
    try {
      parsedArgs = schema.parse(args);
    } catch (zodError) {
      // Try alternative argument structures that MCP might send
      if (typeof args === 'string') {
        parsedArgs = schema.parse({ query: args });
      } else if (args && typeof args.query === 'undefined' && typeof args === 'object') {
        // Handle case where arguments might be nested differently
        const firstKey = Object.keys(args)[0];
        if (firstKey && typeof args[firstKey] === 'string') {
          parsedArgs = schema.parse({ query: args[firstKey] });
        } else {
          throw zodError;
        }
      } else {
        // Log the problematic args for debugging
        this.logger.debug('Failed to parse search args, using fallback', {
          args: typeof args === 'object' ? JSON.stringify(args) : args,
          error: zodError instanceof Error ? zodError.message : 'Unknown parsing error',
        });
        throw zodError;
      }
    }

    const { query, packType, filters, limit } = parsedArgs;

    // Log system detection and filters
    this.logger.info('Compendium search with system detection', {
      gameSystem,
      query,
      filters: filters ? describeFilters(filters, gameSystem) : 'none',
    });

    try {
      const results = await this.foundryClient.query('foundry-mcp-bridge.searchCompendium', {
        query,
        packType,
        filters,
      });

      // Limit results
      const limitedResults = results.slice(0, limit);

      this.logger.debug('Compendium search completed', {
        query,
        gameSystem,
        totalFound: results.length,
        returned: limitedResults.length,
      });

      return {
        query,
        gameSystem, // Include detected system in response
        filterDescription: filters ? describeFilters(filters, gameSystem) : 'no filters',
        results: limitedResults.map((item: any) => this.formatCompendiumItem(item, gameSystem)),
        totalFound: results.length,
        showing: limitedResults.length,
        hasMore: results.length > limit,
      };
    } catch (error) {
      this.logger.error('Failed to search compendium', error);
      throw new Error(
        `Failed to search compendium: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleGetCompendiumItem(args: any): Promise<any> {
    const schema = z.object({
      packId: z.string().min(1, 'Pack ID cannot be empty'),
      itemId: z.string().min(1, 'Item ID cannot be empty'),
      compact: z.boolean().default(false),
    });

    const { packId, itemId, compact } = schema.parse(args);

    try {
      // Use the proper document retrieval method that already exists in actor creation
      const item = await this.foundryClient.query('foundry-mcp-bridge.getCompendiumDocumentFull', {
        packId: packId,
        documentId: itemId,
      });

      if (!item) {
        throw new Error(`Item ${itemId} not found in pack ${packId}`);
      }

      // Format the response using the detailed item data
      const baseResponse = {
        id: item.id,
        name: item.name,
        type: item.type,
        pack: {
          id: item.pack,
          label: item.packLabel,
        },
        description: this.extractDescription(item),
        hasImage: !!item.img,
        imageUrl: item.img,
      };

      if (compact) {
        // Compact response for UI performance
        const compactStats = this.extractCompactStats(item);
        return {
          ...baseResponse,
          stats: compactStats,
          properties: this.extractItemProperties(item),
          items: (item.items || []).slice(0, 5), // Limit items to prevent bloat
          mode: 'compact',
        };
      } else {
        // Full response
        return {
          ...baseResponse,
          fullDescription: this.extractFullDescription(item),
          system: this.sanitizeSystemData(item.system || {}),
          properties: this.extractItemProperties(item),
          items: item.items || [],
          effects: item.effects || [],
          fullData: item.fullData,
          mode: 'full',
        };
      }
    } catch (error) {
      this.logger.error('Failed to get compendium item', error);
      throw new Error(
        `Failed to retrieve item: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleListCompendiumPacks(args: any): Promise<any> {
    const schema = z.object({
      type: z.string().optional(),
    });

    const { type } = schema.parse(args);

    this.logger.info('Listing compendium packs', { type });

    try {
      const packs = await this.foundryClient.query('foundry-mcp-bridge.getAvailablePacks');

      // Filter by type if specified
      const filteredPacks = type ? packs.filter((pack: any) => pack.type === type) : packs;

      this.logger.debug('Successfully retrieved compendium packs', {
        total: packs.length,
        filtered: filteredPacks.length,
        type,
      });

      return {
        packs: filteredPacks.map((pack: any) => ({
          id: pack.id,
          label: pack.label,
          type: pack.type,
          system: pack.system,
          private: pack.private,
        })),
        total: filteredPacks.length,
        availableTypes: [...new Set(packs.map((pack: any) => pack.type))],
      };
    } catch (error) {
      this.logger.error('Failed to list compendium packs', error);
      throw new Error(
        `Failed to list compendium packs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private formatCompendiumItem(item: any, gameSystem?: GameSystem): any {
    const formatted: any = {
      id: item.id,
      name: item.name,
      type: item.type,
      pack: {
        id: item.pack,
        label: item.packLabel,
      },
      description: this.extractDescription(item),
      hasImage: !!item.img,
      summary: this.createItemSummary(item),
    };

    // Add key stats for actors/creatures to reduce need for detail calls.
    // `adversary` is Cosmere RPG's NPC equivalent; mgt2e has several actor types.
    const isMGT2eActor =
      gameSystem === 'mgt2e' &&
      [
        'traveller',
        'npc',
        'creature',
        'spacecraft',
        'vehicle',
        'world',
        'package',
        'swarm',
      ].includes(item.type);
    if (
      item.type === 'npc' ||
      item.type === 'character' ||
      item.type === 'adversary' ||
      isMGT2eActor
    ) {
      const stats: any = {};

      // Use system detection utilities for accurate stat extraction
      if (gameSystem === 'mgt2e') {
        Object.assign(stats, this.extractMGT2eCompactStats(item));
      } else if (gameSystem === 'cosmere-rpg') {
        const system = item.system || {};

        if (typeof system.tier === 'number') stats.tier = system.tier;
        if (typeof system.level === 'number') stats.level = system.level;
        if (typeof system.role === 'string' && system.role) stats.role = system.role.toLowerCase();
        if (typeof system.type?.id === 'string' && system.type.id) {
          stats.creatureType = system.type.id.toLowerCase();
        }
        if (typeof system.type?.subtype === 'string' && system.type.subtype) {
          stats.subtype = system.type.subtype;
        }
        if (typeof system.size === 'string' && system.size) stats.size = system.size.toLowerCase();

        const hpCurrent =
          typeof system.resources?.hea?.value === 'number' ? system.resources.hea.value : undefined;
        const hpMax = readDerived(system.resources?.hea?.max);
        if (hpCurrent !== undefined || hpMax !== undefined) {
          stats.hitPoints = { current: hpCurrent, max: hpMax };
        }

        const phy = readDerived(system.defenses?.phy);
        const cog = readDerived(system.defenses?.cog);
        const spi = readDerived(system.defenses?.spi);
        if (phy !== undefined || cog !== undefined || spi !== undefined) {
          stats.defenses = { phy, cog, spi };
        }

        const deflect = readDerived(system.deflect);
        if (deflect !== undefined) stats.deflect = deflect;

        const investitureMax = readDerived(system.resources?.inv?.max) ?? 0;
        if (investitureMax > 0) stats.hasInvestiture = true;
      } else if (gameSystem) {
        // Level/CR (system-specific)
        const level = getCreatureLevel(item, gameSystem);
        if (level !== undefined) {
          if (gameSystem === 'dnd5e') {
            stats.challengeRating = level;
          } else if (gameSystem === 'pf2e') {
            stats.level = level;
          }
        }

        // Creature type/traits
        const creatureType = getCreatureType(item, gameSystem);
        if (creatureType) {
          if (gameSystem === 'pf2e' && Array.isArray(creatureType)) {
            stats.traits = creatureType;
            // Also extract primary creature type from traits if available
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
            const primaryType = creatureType.find((t: string) =>
              creatureTraits.includes(t.toLowerCase())
            );
            if (primaryType) stats.creatureType = primaryType;
          } else {
            stats.creatureType = creatureType;
          }
        }

        // System-agnostic stats (similar paths in both systems)
        const system = item.system || {};

        // Hit Points
        const hp = system.attributes?.hp?.value;
        const maxHp = system.attributes?.hp?.max;
        if (hp !== undefined || maxHp !== undefined) {
          stats.hitPoints = { current: hp, max: maxHp };
        }

        // Armor Class
        const ac = system.attributes?.ac?.value;
        if (ac !== undefined) stats.armorClass = ac;

        // Size (similar in both systems)
        const size = system.traits?.size?.value || system.traits?.size || system.size;
        if (size) stats.size = size;

        // Alignment (different paths but similar concept)
        const alignment =
          system.details?.alignment?.value || system.details?.alignment || system.alignment;
        if (alignment) stats.alignment = alignment;

        // PF2e specific: Rarity
        if (gameSystem === 'pf2e') {
          const rarity = system.traits?.rarity;
          if (rarity) stats.rarity = rarity;
        }
      } else {
        // Fallback: Legacy D&D 5e extraction
        const system = item.system || {};
        const cr = system.details?.cr || system.cr;
        if (cr !== undefined) stats.challengeRating = cr;

        const hp = system.attributes?.hp?.value || system.hp?.value;
        const maxHp = system.attributes?.hp?.max || system.hp?.max;
        if (hp !== undefined || maxHp !== undefined) {
          stats.hitPoints = { current: hp, max: maxHp };
        }

        const ac = system.attributes?.ac?.value || system.ac?.value;
        if (ac !== undefined) stats.armorClass = ac;

        const creatureType = system.details?.type?.value || system.type?.value;
        if (creatureType) stats.creatureType = creatureType;

        const size = system.traits?.size || system.size;
        if (size) stats.size = size;

        const alignment = system.details?.alignment || system.alignment;
        if (alignment) stats.alignment = alignment;
      }

      if (Object.keys(stats).length > 0) {
        formatted.stats = stats;
      }
    }

    return formatted;
  }

  private formatDetailedCompendiumItem(item: any): any {
    const formatted = this.formatCompendiumItem(item);

    // Add more detailed information
    formatted.system = this.sanitizeSystemData(item.system || {});
    formatted.fullDescription = this.extractFullDescription(item);
    formatted.properties = this.extractItemProperties(item);

    return formatted;
  }

  private extractDescription(item: any): string {
    const system = item.system || {};

    // Try different common description fields
    const description =
      system.description?.value ||
      system.description?.content ||
      system.description ||
      system.details?.description ||
      '';

    return this.truncateText(this.stripHtml(description), 200);
  }

  private extractFullDescription(item: any): string {
    const system = item.system || {};

    const description =
      system.description?.value ||
      system.description?.content ||
      system.description ||
      system.details?.description ||
      '';

    return this.stripHtml(description);
  }

  private createItemSummary(item: any): string {
    const parts = [];

    parts.push(`${item.type} from ${item.packLabel}`);

    const system = item.system || {};

    // Add relevant summary information based on item type
    switch (item.type.toLowerCase()) {
      case 'spell':
        if (system.level) parts.push(`Level ${system.level}`);
        if (system.school) parts.push(system.school);
        break;
      case 'weapon':
        if (system.damage?.parts?.length) {
          const damage = system.damage.parts[0];
          parts.push(`${damage[0]} ${damage[1]} damage`);
        }
        break;
      case 'armor':
        if (system.armor?.value) parts.push(`AC ${system.armor.value}`);
        break;
      case 'equipment':
      case 'item':
        if (system.rarity) parts.push(system.rarity);
        if (system.price?.value)
          parts.push(`${system.price.value} ${system.price.denomination || 'gp'}`);
        break;
    }

    return parts.join(' • ');
  }

  private extractCompactStats(item: any): any {
    const system = item.system || {};
    const stats: any = {};

    // get-compendium-item does not need a separate world-info round trip. These
    // mgt2e shapes are distinctive, and the helper remains empty for other systems.
    Object.assign(stats, this.extractMGT2eCompactStats(item));

    // Core combat stats
    if (system.attributes?.ac?.value) stats.armorClass = system.attributes.ac.value;
    if (system.attributes?.hp?.max) stats.hitPoints = system.attributes.hp.max;
    if (system.details?.cr !== undefined) stats.challengeRating = system.details.cr;

    // Basic info
    if (system.details?.type?.value) stats.creatureType = system.details.type.value;
    if (system.traits?.size) stats.size = system.traits.size;
    if (system.details?.alignment) stats.alignment = system.details.alignment;

    // Key abilities (only show notable ones)
    if (system.abilities) {
      const abilities: any = {};
      for (const [key, ability] of Object.entries(system.abilities)) {
        const abil = ability as any;
        if (abil.value !== undefined) {
          const mod = Math.floor((abil.value - 10) / 2);
          if (Math.abs(mod) >= 2) {
            // Only show significant modifiers
            abilities[key.toUpperCase()] = { value: abil.value, modifier: mod };
          }
        }
      }
      if (Object.keys(abilities).length > 0) stats.abilities = abilities;
    }

    // Speed
    if (system.attributes?.movement) {
      const movement = system.attributes.movement;
      const speeds: string[] = [];
      if (movement.walk) speeds.push(`${movement.walk} ft`);
      if (movement.fly) speeds.push(`fly ${movement.fly} ft`);
      if (movement.swim) speeds.push(`swim ${movement.swim} ft`);
      if (speeds.length > 0) stats.speed = speeds.join(', ');
    }

    return stats;
  }

  /** Extract a bounded mgt2e summary without persistent creature indexing. */
  private extractMGT2eCompactStats(item: any): any {
    const system = item.system || {};
    const stats: any = {};
    const type = String(item.type || '').toLowerCase();
    const looksLikeMGT2e =
      ['traveller', 'spacecraft', 'vehicle', 'package', 'swarm'].includes(type) ||
      !!system.sophont ||
      !!system.spacecraft ||
      !!system.vehicle ||
      !!system.world?.uwp ||
      (type === 'creature' &&
        (typeof system.behaviour === 'string' || typeof system.traits === 'string'));

    if (!looksLikeMGT2e) return stats;

    const hits = system.hits;
    if (typeof hits === 'number') {
      stats.hits = { current: hits, max: hits };
    } else if (hits && typeof hits === 'object') {
      const current = typeof hits.value === 'number' ? hits.value : undefined;
      const max = typeof hits.max === 'number' ? hits.max : undefined;
      if (current !== undefined || max !== undefined) stats.hits = { current, max };
    }

    if (['traveller', 'npc', 'package'].includes(type)) {
      const sophont = system.sophont || {};
      if (sophont.species) stats.species = sophont.species;
      if (sophont.profession) stats.profession = sophont.profession;
      if (sophont.homeworld) stats.homeworld = sophont.homeworld;
    } else if (type === 'creature' || type === 'swarm') {
      if (system.behaviour) stats.behaviour = system.behaviour;
      if (system.traits) stats.traits = system.traits;
    } else if (type === 'spacecraft') {
      const spacecraft = system.spacecraft || {};
      if (typeof spacecraft.dtons === 'number') stats.dtons = spacecraft.dtons;
      if (spacecraft.configuration) stats.configuration = spacecraft.configuration;
      if (spacecraft.tl !== undefined) stats.techLevel = spacecraft.tl;
      if (spacecraft.mdrive !== undefined) stats.mDrive = spacecraft.mdrive;
      if (spacecraft.jdrive !== undefined) stats.jDrive = spacecraft.jdrive;
      if (spacecraft.rdrive !== undefined) stats.rDrive = spacecraft.rdrive;
      if (spacecraft.armour !== undefined) stats.armour = spacecraft.armour;
    } else if (type === 'vehicle') {
      const vehicle = system.vehicle || {};
      if (vehicle.chassis) stats.chassis = vehicle.chassis;
      if (vehicle.subtype) stats.subtype = vehicle.subtype;
      if (vehicle.tl !== undefined) stats.techLevel = vehicle.tl;
      if (vehicle.skill) stats.skill = vehicle.skill;
    } else if (type === 'world' && system.world?.uwp) {
      stats.uwp = system.world.uwp;
    }

    return stats;
  }

  private extractItemProperties(item: any): any {
    const system = item.system || {};
    const properties: any = {};

    // Common properties across different item types
    if (system.rarity) properties.rarity = system.rarity;
    if (system.price) properties.price = system.price;
    if (system.weight) properties.weight = system.weight;
    if (system.quantity) properties.quantity = system.quantity;

    // Spell-specific properties
    if (item.type.toLowerCase() === 'spell') {
      if (system.level !== undefined) properties.spellLevel = system.level;
      if (system.school) properties.school = system.school;
      if (system.components) properties.components = system.components;
      if (system.duration) properties.duration = system.duration;
      if (system.range) properties.range = system.range;
    }

    // Weapon-specific properties
    if (item.type.toLowerCase() === 'weapon') {
      if (system.damage) properties.damage = system.damage;
      if (system.weaponType) properties.weaponType = system.weaponType;
      if (system.properties) properties.weaponProperties = system.properties;
    }

    // Armor-specific properties
    if (item.type.toLowerCase() === 'armor') {
      if (system.armor) properties.armorClass = system.armor;
      if (system.stealth) properties.stealthDisadvantage = system.stealth;
    }

    return properties;
  }

  private sanitizeSystemData(systemData: any): any {
    // Remove potentially large or unnecessary fields
    const sanitized = { ...systemData };

    // Remove large description fields (already handled separately)
    delete sanitized.description;
    delete sanitized.details;

    // Remove internal/technical fields
    delete sanitized._id;
    delete sanitized.folder;
    delete sanitized.sort;
    delete sanitized.ownership;

    return sanitized;
  }

  private stripHtml(text: string | any): string {
    if (!text) return '';

    // Handle objects with value property (e.g., {value: "text"})
    if (typeof text === 'object' && text !== null) {
      if (text.value) {
        text = text.value;
      } else if (text.content) {
        text = text.content;
      } else {
        // For other objects, try to stringify or return empty
        try {
          text = JSON.stringify(text);
        } catch {
          return '';
        }
      }
    }

    // Handle arrays
    if (Array.isArray(text)) {
      return text.map(item => this.stripHtml(item)).join(' ');
    }

    // Ensure we have a string before calling replace()
    if (typeof text !== 'string') {
      const stringified = String(text || '');
      if (!stringified || stringified === '[object Object]') {
        return '';
      }
      text = stringified;
    }

    return text.replace(/<[^>]*>/g, '').trim();
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }
}
