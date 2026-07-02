import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WFRP4eAddItemsToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const itemSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().optional(),
    pack: z.string().optional(),
    advances: z.number().optional(),
    quantity: z.number().optional(),
    setCurrent: z.boolean().optional(),
  })
  .strict();

const addItemsSchema = z
  .object({
    actor: z.string().min(1),
    items: z.array(itemSchema).min(1),
  })
  .strict();

/**
 * WFRP4e add-items tool. Attaches skills, talents, traits, trappings, careers,
 * weapons, spells, etc. to an existing actor by resolving each name against the
 * installed WFRP4e compendiums (full item copied), falling back to a blank item
 * when there is no match.
 */
export class WFRP4eAddItemsTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WFRP4eAddItemsToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WFRP4eAddItemsTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'wfrp4e-add-items',
        description:
          '[WFRP4e only] Add skills, talents, traits, trappings, careers, weapons, spells and ' +
          'other items to an existing actor. Each item is matched by name against the installed ' +
          'WFRP4e compendiums and copied in full, so a skill keeps its linked characteristic, a ' +
          'talent its tests, and a career its progression; a name with no compendium match is ' +
          'added as a blank custom item. Use "advances" to set a skill\'s advances, "quantity" for ' +
          'gear counts, and "setCurrent" to make a career the active one. Pass "type" and/or ' +
          '"pack" to disambiguate a name found in several places. USE THIS to build out a ' +
          "character's items. To create the actor itself use create-actor-from-compendium; to " +
          'change characteristics/wounds or bump a skill the actor already has, use wfrp4e-update-actor.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
            items: {
              type: 'array',
              description: 'Items to add to the actor.',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description:
                      'Item name to look up (e.g. "Stealth (Rural)", "Strike Mighty Blow").',
                  },
                  type: {
                    type: 'string',
                    description:
                      'Optional WFRP item type to disambiguate (skill, talent, trait, trapping, ' +
                      'career, weapon, armour, spell, prayer, …). Also used as the type when a ' +
                      'name is not in any compendium.',
                  },
                  pack: {
                    type: 'string',
                    description:
                      'Optional compendium pack id (or fragment) to source the item from.',
                  },
                  advances: {
                    type: 'number',
                    description: 'Skills only: advances to set on the added skill.',
                  },
                  quantity: {
                    type: 'number',
                    description: 'Gear only: quantity to set on the added item.',
                  },
                  setCurrent: {
                    type: 'boolean',
                    description: "Careers only: make this the actor's current career.",
                  },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
          },
          required: ['actor', 'items'],
        },
      },
    ];
  }

  async handleAddItems(args: unknown) {
    const parsed = addItemsSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, items } = parsed.data;
    this.logger.info('Adding WFRP4e items', { actor, count: items.length });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.addWfrp4eItems', { actor, items });
    } catch (error) {
      this.logger.error('Failed to add WFRP4e items', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
