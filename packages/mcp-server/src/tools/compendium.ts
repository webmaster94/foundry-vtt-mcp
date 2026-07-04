import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { SystemRegistry } from '../systems/system-registry.js';
import {
  detectGameSystem,
  getSystemPaths,
  getCreatureLevel,
  getCreatureType,
  hasSpellcasting,
  formatSystemError,
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
  private gameSystem: GameSystem | null = null;

  constructor({ foundryClient, logger, systemRegistry }: CompendiumToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CompendiumTools' });
    this.systemRegistry = systemRegistry || null;
  }

  /**
   * Get or detect the game system (cached)
   */
  private async getGameSystem(): Promise<GameSystem> {
    if (!this.gameSystem) {
      this.gameSystem = await detectGameSystem(this.foundryClient, this.logger);
    }
    return this.gameSystem;
  }

  /**
   * Tool definitions for compendium operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'search-compendium',
        description:
          'Search compendium packs by entry NAME only (descriptions are not searched; the filters are name-keyword heuristics). For real system-data filters (spell level, item type, CR) use search-compendium-contents; for indexed creature filtering use list-creatures-by-criteria.',
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
        name: 'list-creatures-by-criteria',
        description:
          'Indexed creature discovery for encounter building. Filters by real stats with automatic system detection: D&D 5e CR, PF2e level/traits/rarity, Cosmere tier/role/investiture. Returns minimal rows; pull details for finalists with get-compendium-item.',
        inputSchema: {
          type: 'object',
          properties: {
            challengeRating: {
              description: 'D&D 5e: number, string, or {min,max}',
              oneOf: [
                { type: 'number' },
                { type: 'string' },
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
            hasSpells: { type: 'boolean' },
            hasLegendaryActions: { type: 'boolean' },
            level: {
              description: 'PF2e: number, string, or {min,max}',
              oneOf: [
                { type: 'number' },
                { type: 'string' },
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
            tier: {
              description: 'Cosmere: 1-4 or {min,max}',
              oneOf: [
                { type: 'number' },
                {
                  type: 'object',
                  properties: { min: { type: 'number' }, max: { type: 'number' } },
                },
              ],
            },
            role: { type: 'string', description: 'Cosmere: minion/rival/boss' },
            hasInvestiture: { type: 'boolean', description: 'Cosmere' },
            hitPoints: {
              oneOf: [
                { type: 'number' },
                {
                  type: 'object',
                  properties: { min: { type: 'number' }, max: { type: 'number' } },
                },
              ],
            },
            defensesMin: {
              type: 'object',
              properties: {
                phy: { type: 'number' },
                cog: { type: 'number' },
                spi: { type: 'number' },
              },
              additionalProperties: false,
              description: 'Cosmere minimum defenses',
            },
            deflectMin: { type: 'number', description: 'Cosmere' },
            limit: { type: 'number', minimum: 1, maximum: 1000, default: 500 },
          },
          required: [],
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

  async handleListCreaturesByCriteria(args: any): Promise<any> {
    // Detect game system for appropriate filtering
    const gameSystem = await this.getGameSystem();

    // Use generic filters schema to support both systems
    const schema = z.object({
      // D&D 5e: challengeRating
      challengeRating: z
        .union([
          z.object({
            min: z.number().optional().default(0),
            max: z.number().optional().default(30),
          }),
          z
            .string()
            .refine(
              val => {
                try {
                  const parsed = JSON.parse(val);
                  return (
                    typeof parsed === 'object' &&
                    parsed !== null &&
                    (typeof parsed.min === 'number' || typeof parsed.max === 'number')
                  );
                } catch {
                  return false;
                }
              },
              {
                message: 'Challenge rating range must be valid JSON object with min/max numbers',
              }
            )
            .transform(val => {
              const parsed = JSON.parse(val);
              return {
                min: parsed.min || 0,
                max: parsed.max || 30,
              };
            }),
          z.number(),
          z
            .string()
            .refine(val => !isNaN(parseFloat(val)), {
              message: 'Challenge rating must be a valid number',
            })
            .transform(val => parseFloat(val)),
        ])
        .optional(),

      // Pathfinder 2e: level
      level: z
        .union([
          z.object({
            min: z.number().optional().default(-1),
            max: z.number().optional().default(25),
          }),
          z
            .string()
            .refine(val => {
              try {
                const parsed = JSON.parse(val);
                return (
                  typeof parsed === 'object' &&
                  parsed !== null &&
                  (typeof parsed.min === 'number' || typeof parsed.max === 'number')
                );
              } catch {
                return false;
              }
            })
            .transform(val => {
              const parsed = JSON.parse(val);
              return {
                min: parsed.min ?? -1,
                max: parsed.max ?? 25,
              };
            }),
          z.number(),
          z
            .string()
            .refine(val => !isNaN(parseFloat(val)))
            .transform(val => parseFloat(val)),
        ])
        .optional(),

      // Common filters
      creatureType: z.string().optional(), // Accept any string, validate per system
      size: z.enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']).optional(),

      // Pathfinder 2e specific
      traits: z.array(z.string()).optional(),
      rarity: z.enum(['common', 'uncommon', 'rare', 'unique']).optional(),

      // Cosmere RPG specific
      tier: z
        .union([
          z.object({
            min: z.number().optional(),
            max: z.number().optional(),
          }),
          z
            .string()
            .refine(
              val => {
                try {
                  const parsed = JSON.parse(val);
                  return (
                    typeof parsed === 'object' &&
                    parsed !== null &&
                    (typeof parsed.min === 'number' || typeof parsed.max === 'number')
                  );
                } catch {
                  return false;
                }
              },
              { message: 'Tier range must be valid JSON object with min/max numbers' }
            )
            .transform(val => JSON.parse(val) as { min?: number; max?: number }),
          z.number(),
          z
            .string()
            .refine(val => !isNaN(parseFloat(val)), {
              message: 'Tier must be a valid number',
            })
            .transform(val => parseFloat(val)),
        ])
        .optional(),
      role: z.string().optional(),
      hasInvestiture: z
        .union([
          z.boolean(),
          z
            .string()
            .refine(v => ['true', 'false'].includes(v.toLowerCase()))
            .transform(v => v.toLowerCase() === 'true'),
        ])
        .optional(),
      hitPoints: z
        .union([
          z.object({
            min: z.number().optional(),
            max: z.number().optional(),
          }),
          z
            .string()
            .refine(
              val => {
                try {
                  const parsed = JSON.parse(val);
                  return (
                    typeof parsed === 'object' &&
                    parsed !== null &&
                    (typeof parsed.min === 'number' || typeof parsed.max === 'number')
                  );
                } catch {
                  return false;
                }
              },
              { message: 'hitPoints range must be valid JSON object with min/max numbers' }
            )
            .transform(val => JSON.parse(val) as { min?: number; max?: number }),
          z.number(),
          z
            .string()
            .refine(val => !isNaN(parseFloat(val)), {
              message: 'hitPoints must be a valid number',
            })
            .transform(val => parseFloat(val)),
        ])
        .optional(),
      defensesMin: z
        .object({
          phy: z.number().optional(),
          cog: z.number().optional(),
          spi: z.number().optional(),
        })
        .optional(),
      deflectMin: z
        .union([
          z.number(),
          z
            .string()
            .refine(val => !isNaN(parseFloat(val)), {
              message: 'deflectMin must be a valid number',
            })
            .transform(val => parseFloat(val)),
        ])
        .optional(),

      // Spellcasting flags (different names per system)
      hasSpells: z
        .union([
          z.boolean(),
          z
            .string()
            .refine(val => ['true', 'false'].includes(val.toLowerCase()))
            .transform(val => val.toLowerCase() === 'true'),
        ])
        .optional(),
      hasLegendaryActions: z
        .union([
          z.boolean(),
          z
            .string()
            .refine(val => ['true', 'false'].includes(val.toLowerCase()))
            .transform(val => val.toLowerCase() === 'true'),
        ])
        .optional(),

      limit: z
        .union([
          z.number().min(1).max(1000),
          z
            .string()
            .refine(val => {
              const num = parseInt(val, 10);
              return !isNaN(num) && num >= 1 && num <= 1000;
            })
            .transform(val => parseInt(val, 10)),
        ])
        .optional()
        .default(100),
    });

    let params;
    try {
      params = schema.parse(args);
      this.logger.debug('Parsed creature criteria parameters successfully', params);
    } catch (parseError) {
      this.logger.error('Failed to parse creature criteria parameters', { args, parseError });
      if (parseError instanceof z.ZodError) {
        const errorDetails = parseError.errors
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(
          `Parameter validation failed: ${errorDetails}. Received args: ${JSON.stringify(args)}`
        );
      }
      throw parseError;
    }

    // Log system detection and criteria
    const criteriaDescription = this.describeCriteria(params, gameSystem);
    this.logger.info('Creature criteria search with system detection', {
      gameSystem,
      criteria: criteriaDescription,
    });

    try {
      const results = await this.foundryClient.query(
        'foundry-mcp-bridge.listCreaturesByCriteria',
        params
      );

      this.logger.debug('Creature criteria search completed', {
        gameSystem,
        criteriaCount: Object.keys(params).length,
        totalFound: results.response?.creatures?.length || 0,
        limit: params.limit,
        packsSearched: results.response?.searchSummary?.packsSearched || 0,
      });

      // Extract search summary for transparency
      const searchSummary = results.response?.searchSummary || {
        packsSearched: 0,
        topPacks: [],
        totalCreaturesFound: results.response?.creatures?.length || 0,
      };

      return {
        gameSystem, // Include detected system
        criteriaDescription, // Human-readable criteria
        creatures: (results.response?.creatures || results).map((creature: any) =>
          this.formatCreatureListItem(creature, gameSystem)
        ),
        totalFound: results.response?.creatures?.length || results.length,
        criteria: params,
        searchSummary: {
          ...searchSummary,
          searchStrategy: `Prioritized pack search - ${gameSystem === 'pf2e' ? 'PF2e' : gameSystem === 'cosmere-rpg' ? 'Cosmere RPG' : 'D&D 5e'} content first, then modules, then campaign-specific`,
          note: 'Packs searched in priority order to find most relevant creatures first',
        },
        optimizationNote:
          'Use creature names to identify suitable options, then call get-compendium-item for final details only',
      };
    } catch (error) {
      this.logger.error('Failed to list creatures by criteria', error);
      throw new Error(
        `Failed to list creatures: ${error instanceof Error ? error.message : 'Unknown error'}`
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
    // `adversary` is Cosmere RPG's NPC equivalent.
    if (item.type === 'npc' || item.type === 'character' || item.type === 'adversary') {
      const stats: any = {};

      // Use system detection utilities for accurate stat extraction
      if (gameSystem === 'cosmere-rpg') {
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

  private formatCreatureListItem(creature: any, gameSystem?: GameSystem): any {
    const system = creature.system || {};
    const formatted: any = {
      name: creature.name,
      id: creature.id,
      pack: { id: creature.pack, label: creature.packLabel },
    };

    if (gameSystem === 'cosmere-rpg') {
      // Cosmere fields come pre-flattened from data-access.ts; pass them through.
      if (creature.tier !== undefined) formatted.tier = creature.tier;
      if (creature.role) formatted.role = creature.role;
      if (creature.subtype) formatted.subtype = creature.subtype;
      if (creature.creatureType) formatted.creatureType = creature.creatureType;
      if (creature.size) formatted.size = creature.size;
      if (creature.hitPoints !== undefined) formatted.hitPoints = creature.hitPoints;
      if (creature.focus !== undefined) formatted.focus = creature.focus;
      if (creature.investiture !== undefined) formatted.investiture = creature.investiture;
      if (creature.hasInvestiture !== undefined) formatted.hasInvestiture = creature.hasInvestiture;
      if (creature.defenses) formatted.defenses = creature.defenses;
      if (creature.deflect !== undefined) formatted.deflect = creature.deflect;
      if (creature.walkSpeed !== undefined) formatted.walkSpeed = creature.walkSpeed;
      if (creature.summary) formatted.summary = creature.summary;
      return formatted;
    }

    if (gameSystem) {
      // System-specific extraction using detection utilities
      const level = getCreatureLevel(creature, gameSystem);
      if (level !== undefined) {
        if (gameSystem === 'dnd5e') {
          formatted.challengeRating = level;
        } else if (gameSystem === 'pf2e') {
          formatted.level = level;
        }
      }

      const creatureType = getCreatureType(creature, gameSystem);
      if (creatureType) {
        if (gameSystem === 'pf2e' && Array.isArray(creatureType)) {
          formatted.traits = creatureType;
          // Extract primary type from traits
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
          if (primaryType) formatted.creatureType = primaryType;
        } else {
          formatted.creatureType = creatureType;
        }
      }

      const size = system.traits?.size?.value || system.traits?.size || system.size || 'medium';
      formatted.size = size;

      // PF2e specific: rarity
      if (gameSystem === 'pf2e') {
        const rarity = system.traits?.rarity;
        if (rarity) formatted.rarity = rarity;
      }

      // Feature flags
      const hasSpells = hasSpellcasting(creature, gameSystem);
      formatted.flags = {
        spellcaster: hasSpells,
      };

      // D&D 5e specific flags
      if (gameSystem === 'dnd5e') {
        const hasLegendary = !!(
          system.resources?.legact ||
          system.legendary ||
          (system.resources?.legres && system.resources.legres.value > 0)
        );
        formatted.flags.legendary = hasLegendary;

        const typeStr = typeof creatureType === 'string' ? creatureType.toLowerCase() : '';
        formatted.flags.undead = typeStr === 'undead';
        formatted.flags.dragon = typeStr === 'dragon';
        formatted.flags.fiend = typeStr === 'fiend';
      }
    } else {
      // Legacy fallback (D&D 5e assumptions)
      const challengeRating = creature.challengeRating ?? system.details?.cr ?? system.cr ?? 0;
      const creatureType =
        creature.creatureType ?? system.details?.type?.value ?? system.type?.value ?? 'unknown';
      const size = creature.size ?? system.traits?.size ?? system.size ?? 'medium';

      const hasSpells =
        creature.hasSpells ??
        !!(
          system.spells ||
          system.attributes?.spellcasting ||
          (system.details?.spellLevel && system.details.spellLevel > 0)
        );
      const hasLegendary =
        creature.hasLegendaryActions ??
        !!(
          system.resources?.legact ||
          system.legendary ||
          (system.resources?.legres && system.resources.legres.value > 0)
        );

      formatted.challengeRating = challengeRating;
      formatted.creatureType = creatureType;
      formatted.size = size;
      formatted.flags = {
        spellcaster: hasSpells,
        legendary: hasLegendary,
        undead: creatureType.toLowerCase() === 'undead',
        dragon: creatureType.toLowerCase() === 'dragon',
        fiend: creatureType.toLowerCase() === 'fiend',
      };
    }

    return formatted;
  }

  /**
   * Helper method to describe criteria in human-readable format
   */
  private describeCriteria(params: any, gameSystem: GameSystem): string {
    const parts: string[] = [];

    if (gameSystem === 'dnd5e') {
      if (params.challengeRating !== undefined) {
        if (typeof params.challengeRating === 'number') {
          parts.push(`CR ${params.challengeRating}`);
        } else if (typeof params.challengeRating === 'object') {
          const min = params.challengeRating.min ?? 0;
          const max = params.challengeRating.max ?? 30;
          parts.push(`CR ${min}-${max}`);
        }
      }
    } else if (gameSystem === 'pf2e') {
      if (params.level !== undefined) {
        if (typeof params.level === 'number') {
          parts.push(`Level ${params.level}`);
        } else if (typeof params.level === 'object') {
          const min = params.level.min ?? -1;
          const max = params.level.max ?? 25;
          parts.push(`Level ${min}-${max}`);
        }
      }
    } else if (gameSystem === 'cosmere-rpg') {
      if (params.tier !== undefined) {
        if (typeof params.tier === 'number') {
          parts.push(`Tier ${params.tier}`);
        } else if (typeof params.tier === 'object') {
          const min = params.tier.min ?? 1;
          const max = params.tier.max ?? 4;
          parts.push(`Tier ${min}-${max}`);
        }
      }
      if (params.role) parts.push(`role=${String(params.role).toLowerCase()}`);
      if (params.hasInvestiture !== undefined) {
        parts.push(params.hasInvestiture ? 'has Investiture' : 'no Investiture');
      }
      if (params.hitPoints !== undefined) {
        if (typeof params.hitPoints === 'number') {
          parts.push(`hp=${params.hitPoints}`);
        } else if (typeof params.hitPoints === 'object') {
          const min = params.hitPoints.min;
          const max = params.hitPoints.max;
          if (min !== undefined && max !== undefined) parts.push(`hp ${min}-${max}`);
          else if (min !== undefined) parts.push(`hp>=${min}`);
          else if (max !== undefined) parts.push(`hp<=${max}`);
        }
      }
      if (params.defensesMin) {
        const { phy, cog, spi } = params.defensesMin;
        if (phy !== undefined) parts.push(`phy>=${phy}`);
        if (cog !== undefined) parts.push(`cog>=${cog}`);
        if (spi !== undefined) parts.push(`spi>=${spi}`);
      }
      if (params.deflectMin !== undefined) parts.push(`deflect>=${params.deflectMin}`);
    }

    if (params.creatureType) parts.push(params.creatureType);
    if (params.size) parts.push(params.size);
    if (params.rarity) parts.push(params.rarity);
    if (params.traits && params.traits.length > 0) {
      parts.push(`traits: ${params.traits.join(', ')}`);
    }
    if (params.hasSpells) parts.push('spellcaster');
    if (params.hasLegendaryActions) parts.push('legendary');

    return parts.length > 0 ? parts.join(', ') : 'no criteria';
  }

  private extractCompactStats(item: any): any {
    const system = item.system || {};
    const stats: any = {};

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
