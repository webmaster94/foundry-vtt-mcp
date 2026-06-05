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
    wounds: z
      .object({ value: z.number().optional(), max: z.number().optional() })
      .strict()
      .optional(),
    skills: z
      .array(z.object({ name: z.string().min(1), advances: z.number() }).strict())
      .optional(),
    career: z.string().min(1).optional(),
    movement: z.number().optional(),
    biography: z.string().optional(),
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
          'initial/advances/modifier, wounds (current value and max), the advances on ' +
          'skills the actor already has, which career is current, base movement, and/or ' +
          'the biography text. Only the fields ' +
          'you provide change; the characteristic Total/Bonus and skill totals recompute ' +
          'automatically. USE THIS to tweak a creature/NPC/PC you already have — e.g. after ' +
          'cloning a creature to make a tougher variant, or to advance a skill. To ADD a new ' +
          'skill, talent, trait, trapping or career use wfrp4e-add-items; to create an actor ' +
          'use create-actor-from-compendium.',
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
            skills: {
              type: 'array',
              description:
                'Set advances on skills the actor ALREADY has. To add a new skill use ' +
                'wfrp4e-add-items instead.',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Existing skill name (e.g. "Stealth (Rural)").',
                  },
                  advances: { type: 'number', description: 'Advances to set on the skill.' },
                },
                required: ['name', 'advances'],
                additionalProperties: false,
              },
            },
            career: {
              type: 'string',
              description:
                "Name of an existing career item to make the actor's current career (the others " +
                'are set non-current).',
            },
            movement: {
              type: 'number',
              description: 'Base Movement value (system.details.move).',
            },
            biography: {
              type: 'string',
              description:
                'Biography / notes text for the actor (replaces the current biography; HTML allowed).',
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

    const { actor, characteristics, wounds, skills, career, movement, biography } = parsed.data;
    if (
      !characteristics &&
      !wounds &&
      !skills?.length &&
      !career &&
      movement === undefined &&
      biography === undefined
    ) {
      return {
        success: false,
        error:
          'Nothing to update: provide characteristics, wounds, skills, career, movement and/or biography.',
      };
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
        skills,
        career,
        movement,
        biography,
      });
    } catch (error) {
      this.logger.error('Failed to update WFRP4e actor', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
