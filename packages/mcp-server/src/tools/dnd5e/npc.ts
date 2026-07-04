import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { ErrorHandler } from '../../utils/error-handler.js';
import { detectGameSystem, getCachedSystemId } from '../../utils/system-detection.js';

// ---------------------------------------------------------------------------
// Canonical value sets for soft validation (warnings, not errors)
// ---------------------------------------------------------------------------

const DAMAGE_CANONICAL = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

const CONDITION_CANONICAL = new Set([
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);

// ---------------------------------------------------------------------------
// CR helpers
// ---------------------------------------------------------------------------

/**
 * Converts a CR string ("1/4", "1/2", "5") or number (0.25, 5) to a float.
 */
function normalizeCR(input: string | number): number {
  if (typeof input === 'number') return input;
  if (input.includes('/')) {
    const [num, den] = input.split('/').map(Number);
    return num / den;
  }
  return parseInt(input, 10);
}

/**
 * Formats a CR float back to the canonical display string.
 */
function formatCR(value: number): string {
  if (value === 0) return '0';
  if (value === 0.125) return '1/8';
  if (value === 0.25) return '1/4';
  if (value === 0.5) return '1/2';
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5eNpcToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5eNpcTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: DnD5eNpcToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DnD5eNpcTools' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    const speed = { type: 'number', minimum: 0, default: 0 };
    const sense = { type: 'number', minimum: 0, default: 0 };
    const strArray = { type: 'array', items: { type: 'string' }, default: [] };
    const score = { type: 'number', minimum: 1, maximum: 30 };
    return [
      {
        name: 'dnd5e-create-npc',
        description:
          '[D&D 5e] Create an NPC actor with a full stat block: identity, CR, abilities, saves, HP, AC, ' +
          'speeds, senses, skills, damage/condition traits, languages, biography. Add actions/spells ' +
          'AFTERWARD with dnd5e-add-feature. Placed in the "Foundry MCP Creatures" folder. ' +
          '(Alternative: build-actor-from-spec clones a compendium template instead.)',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            creatureType: {
              type: 'string',
              enum: [
                'humanoid',
                'undead',
                'beast',
                'dragon',
                'aberration',
                'construct',
                'elemental',
                'fey',
                'fiend',
                'giant',
                'monstrosity',
                'ooze',
                'plant',
                'celestial',
                'swarm',
              ],
            },
            creatureSubtype: { type: 'string', default: '' },
            size: {
              type: 'string',
              enum: ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'],
            },
            alignment: { type: 'string', default: '' },
            cr: {
              description: 'number (0,1,5), fraction string ("1/4"), or decimal (0.25)',
              oneOf: [
                { type: 'string', pattern: '^\\d+(\\/[248])?$' },
                { type: 'number', minimum: 0 },
              ],
            },
            hpAverage: { type: 'number', minimum: 1 },
            hpFormula: { type: 'string', description: 'e.g. "3d8+9"' },
            acMode: { type: 'string', enum: ['default', 'flat'] },
            acValue: {
              type: 'number',
              minimum: 0,
              maximum: 30,
              description: 'required when acMode "flat"',
            },
            abilities: {
              type: 'object',
              properties: {
                str: score,
                dex: score,
                con: score,
                int: score,
                wis: score,
                cha: score,
              },
              required: ['str', 'dex', 'con', 'int', 'wis', 'cha'],
            },
            savingThrows: {
              type: 'array',
              items: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
              default: [],
            },
            walkSpeed: { ...speed, default: 30 },
            flySpeed: speed,
            swimSpeed: speed,
            climbSpeed: speed,
            burrowSpeed: speed,
            hover: { type: 'boolean', default: false },
            darkvision: sense,
            blindsight: sense,
            tremorsense: sense,
            truesight: sense,
            specialSenses: { type: 'string', default: '' },
            skills: {
              type: 'array',
              default: [],
              items: {
                type: 'object',
                properties: {
                  skill: { type: 'string', description: 'e.g. "Perception", "Stealth"' },
                  proficiency: { type: 'string', enum: ['proficient', 'expert'] },
                },
                required: ['skill', 'proficiency'],
              },
            },
            damageImmunities: { ...strArray, description: 'e.g. ["necrotic","poison"]' },
            damageResistances: strArray,
            damageVulnerabilities: strArray,
            conditionImmunities: { ...strArray, description: 'e.g. ["charmed","frightened"]' },
            languages: strArray,
            languagesCustom: {
              type: 'string',
              default: '',
              description: 'e.g. "telepathy 60 ft."',
            },
            biography: { type: 'string', default: '', description: 'HTML' },
            sourceBook: { type: 'string', default: '' },
            sourcePage: { type: 'string', default: '' },
            sourceRules: { type: 'string', enum: ['2014', '2024'], default: '2014' },
          },
          required: [
            'name',
            'creatureType',
            'size',
            'cr',
            'abilities',
            'hpAverage',
            'hpFormula',
            'acMode',
          ],
        },
      },
    ];
  }
  async handleCreateNpc(args: any): Promise<any> {
    const schema = z
      .object({
        // Identity
        name: z.string().min(1, 'name cannot be empty'),
        creatureType: z.enum([
          'humanoid',
          'undead',
          'beast',
          'dragon',
          'aberration',
          'construct',
          'elemental',
          'fey',
          'fiend',
          'giant',
          'monstrosity',
          'ooze',
          'plant',
          'celestial',
          'swarm',
        ]),
        creatureSubtype: z.string().default(''),
        size: z.enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']),
        alignment: z.string().default(''),
        cr: z.union([
          z
            .string()
            .regex(
              /^\d+(\/[248])?$/,
              'CR must be a whole number or fraction string (e.g. "0", "1/4", "1/2", "5")'
            ),
          z.number().finite().min(0),
        ]),
        // HP
        hpAverage: z.number().int().min(1),
        hpFormula: z.string().min(1, 'hpFormula cannot be empty'),
        // AC
        acMode: z.enum(['default', 'flat']),
        acValue: z.number().int().min(0).max(30).optional(),
        // Abilities
        abilities: z.object({
          str: z.number().int().min(1).max(30),
          dex: z.number().int().min(1).max(30),
          con: z.number().int().min(1).max(30),
          int: z.number().int().min(1).max(30),
          wis: z.number().int().min(1).max(30),
          cha: z.number().int().min(1).max(30),
        }),
        savingThrows: z.array(z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha'])).default([]),
        // Movement
        walkSpeed: z.number().int().min(0).default(30),
        flySpeed: z.number().int().min(0).default(0),
        swimSpeed: z.number().int().min(0).default(0),
        climbSpeed: z.number().int().min(0).default(0),
        burrowSpeed: z.number().int().min(0).default(0),
        hover: z.boolean().default(false),
        // Senses
        darkvision: z.number().int().min(0).default(0),
        blindsight: z.number().int().min(0).default(0),
        tremorsense: z.number().int().min(0).default(0),
        truesight: z.number().int().min(0).default(0),
        specialSenses: z.string().default(''),
        // Skills
        skills: z
          .array(
            z.object({
              skill: z.enum([
                'Acrobatics',
                'Animal Handling',
                'Arcana',
                'Athletics',
                'Deception',
                'History',
                'Insight',
                'Intimidation',
                'Investigation',
                'Medicine',
                'Nature',
                'Perception',
                'Performance',
                'Persuasion',
                'Religion',
                'Sleight of Hand',
                'Stealth',
                'Survival',
              ]),
              proficiency: z.enum(['proficient', 'expert']),
            })
          )
          .default([]),
        // Damage & condition traits
        damageImmunities: z.array(z.string()).default([]),
        damageResistances: z.array(z.string()).default([]),
        damageVulnerabilities: z.array(z.string()).default([]),
        conditionImmunities: z.array(z.string()).default([]),
        // Languages
        languages: z.array(z.string()).default([]),
        languagesCustom: z.string().default(''),
        // Biography & source
        biography: z.string().default(''),
        sourceBook: z.string().default(''),
        sourcePage: z.string().default(''),
        sourceRules: z.enum(['2014', '2024']).default('2014'),
      })
      .superRefine((data, ctx) => {
        if (data.acMode === 'flat' && data.acValue === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['acValue'],
            message: 'acValue is required when acMode is "flat"',
          });
        }
      });

    const parsed = schema.parse(args);

    // -----------------------------------------------------------------------
    // Soft validation — collect warnings, do NOT block creation
    // -----------------------------------------------------------------------
    const warnings: string[] = [];

    const allDamageValues = [
      ...parsed.damageImmunities.map(v => ({ field: 'damageImmunities', value: v })),
      ...parsed.damageResistances.map(v => ({ field: 'damageResistances', value: v })),
      ...parsed.damageVulnerabilities.map(v => ({ field: 'damageVulnerabilities', value: v })),
    ];
    for (const { field, value } of allDamageValues) {
      if (!DAMAGE_CANONICAL.has(value)) {
        const msg = `Unknown damage type "${value}" in ${field} — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { field, value });
      }
    }
    for (const value of parsed.conditionImmunities) {
      if (!CONDITION_CANONICAL.has(value)) {
        const msg = `Unknown condition "${value}" in conditionImmunities — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { value });
      }
    }

    this.logger.info('Creating D&D 5e NPC', {
      name: parsed.name,
      creatureType: parsed.creatureType,
      cr: parsed.cr,
      warnings: warnings.length,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-create-npc requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.createNpcActor', parsed);

      this.logger.info('NPC created successfully', {
        actorId: result.actor?.id,
        actorName: result.actor?.name,
      });

      return this.formatResponse(result, parsed, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-create-npc', 'NPC creation');
    }
  }

  private formatResponse(result: any, params: any, warnings: string[]): any {
    const crStr = result.actor?.cr ?? formatCR(normalizeCR(params.cr));

    const abilityLine = (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const)
      .map(ab => `${ab.toUpperCase()} ${params.abilities[ab]}`)
      .join(' / ');

    const acDisplay = params.acMode === 'flat' ? String(params.acValue) : 'default (calculated)';

    const summary = `✅ NPC "${result.actor.name}" created (CR ${crStr})`;

    const lines = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Type:** ${params.creatureType}${params.creatureSubtype ? ` (${params.creatureSubtype})` : ''}, ${params.size}`,
      `**CR:** ${crStr}  |  **HP:** ${params.hpAverage} (${params.hpFormula})  |  **AC:** ${acDisplay}`,
      `**Abilities:** ${abilityLine}`,
    ];

    if (result.actor.folder) {
      lines.push(`**Folder:** ${result.actor.folder}`);
    }

    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
        : '';

    return {
      summary,
      success: true,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${lines.join('\n')}${warningSection}`,
    };
  }
}
