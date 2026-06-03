import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WFRP4eUpdateActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const CHAR_KEYS = ['ws', 'bs', 's', 't', 'i', 'ag', 'dex', 'int', 'wp', 'fel'] as const;

const charFieldSchema = z
  .object({
    initial: z.number().optional(),
    advances: z.number().optional(),
    modifier: z.number().optional(),
  })
  .strict();

const updateActorSchema = z
  .object({
    actor: z.string().min(1),
    characteristics: z.record(z.string(), charFieldSchema).optional(),
    wounds: z.object({ value: z.number().optional(), max: z.number().optional() }).strict().optional(),
  })
  .strict();

/**
 * WFRP4e actor-update tool. Patches an existing actor's stat block
 * (characteristics and/or wounds); WFRP4e recomputes derived value/bonus.
 */
export class WFRP4eUpdateActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WFRP4eUpdateActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WFRP4eUpdateActorTools' });
  }

  getToolDefinitions() {
    const charProperty = {
      type: 'object',
      properties: {
        initial: { type: 'number', description: 'Base characteristic value' },
        advances: { type: 'number', description: 'Points advanced in this characteristic' },
        modifier: { type: 'number', description: 'Modifier (may be negative)' },
      },
      additionalProperties: false,
    };
    const characteristicProps: Record<string, unknown> = {};
    for (const key of CHAR_KEYS) characteristicProps[key] = charProperty;

    return [
      {
        name: 'wfrp4e-update-actor',
        description:
          "[WFRP4e only] Update an existing actor's stat block: characteristic " +
          'initial/advances/modifier and/or wounds (current value and max). Only the ' +
          'fields you provide change; the characteristic Total and Bonus recompute ' +
          'automatically. USE THIS to tweak a creature/NPC/PC you already have — e.g. ' +
          'after cloning a creature to make a tougher variant. DO NOT use this to create ' +
          'an actor (use create-actor-from-compendium) or to add/remove items, spells, ' +
          'or talents (use manage-world-items).',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
            characteristics: {
              type: 'object',
              description:
                'Per-characteristic updates. Keys: ws, bs, s, t, i, ag, dex, int, wp, fel. ' +
                'Each may set initial, advances and/or modifier.',
              properties: characteristicProps,
              additionalProperties: false,
            },
            wounds: {
              type: 'object',
              description: 'Wound (hit point) updates.',
              properties: {
                value: { type: 'number', description: 'Current wounds' },
                max: { type: 'number', description: 'Maximum wounds' },
              },
              additionalProperties: false,
            },
          },
          required: ['actor'],
        },
      },
    ];
  }

  async handleUpdateActor(args: unknown) {
    const parsed = updateActorSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, characteristics, wounds } = parsed.data;
    if (!characteristics && !wounds) {
      return { success: false, error: 'Nothing to update: provide characteristics and/or wounds.' };
    }

    // Surface unknown characteristic keys early (clearer than a silent skip).
    if (characteristics) {
      const unknown = Object.keys(characteristics).filter(
        k => !CHAR_KEYS.includes(k.toLowerCase() as (typeof CHAR_KEYS)[number])
      );
      if (unknown.length > 0) {
        return {
          success: false,
          error: `Unknown characteristic key(s): ${unknown.join(', ')}. Valid keys: ${CHAR_KEYS.join(', ')}.`,
        };
      }
    }

    this.logger.info('Updating WFRP4e actor', { actor });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.updateWfrp4eActor', {
        actor,
        characteristics,
        wounds,
      });
    } catch (error) {
      this.logger.error('Failed to update WFRP4e actor', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
