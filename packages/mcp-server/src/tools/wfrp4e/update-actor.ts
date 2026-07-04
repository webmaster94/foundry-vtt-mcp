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
        initial: { type: 'number' },
        advances: { type: 'number' },
        modifier: { type: 'number' },
      },
      additionalProperties: false,
    };
    const characteristicProps: Record<string, unknown> = {};
    for (const key of CHAR_KEYS) characteristicProps[key] = charProperty;

    return [
      {
        name: 'wfrp4e-update-actor',
        description:
          "[WFRP4e] Update an actor's stat block: characteristics (initial/advances/modifier), wounds, " +
          'advances on existing skills, current career, movement, biography. Only provided fields change; ' +
          'totals recompute. To ADD skills/talents/trappings use wfrp4e-add-items.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: { type: 'string', description: 'Actor name or id' },
            characteristics: {
              type: 'object',
              description: 'Keys: ws bs s t i ag dex int wp fel',
              properties: characteristicProps,
              additionalProperties: false,
            },
            wounds: {
              type: 'object',
              properties: { value: { type: 'number' }, max: { type: 'number' } },
              additionalProperties: false,
            },
            skills: {
              type: 'array',
              description: 'Set advances on skills the actor already has',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, advances: { type: 'number' } },
                required: ['name', 'advances'],
                additionalProperties: false,
              },
            },
            career: { type: 'string', description: 'Existing career item to make current' },
            movement: { type: 'number' },
            biography: { type: 'string', description: 'Replaces biography; HTML allowed' },
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
