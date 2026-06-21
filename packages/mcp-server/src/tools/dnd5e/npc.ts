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
    return [
      {
        name: 'dnd5e-create-npc',
        description:
          '[D&D 5e only] Create a new NPC actor from scratch with a full Level-2 stat block: ' +
          'identity (name, type, size, alignment, CR), ability scores, saving throw proficiencies, ' +
          'HP (average + formula), AC (default or flat), movement speeds, senses, skill proficiencies, ' +
          'damage immunities/resistances/vulnerabilities, condition immunities, languages, and biography. ' +
          'Items, actions, features, and spells are NOT added by this tool — use dnd5e-add-feature ' +
          '(featureType: "passive", "save", "attack", "attack-with-save", "aura", "spellcasting", or "spells") ' +
          'to add them after creation. The actor is placed in the "Foundry MCP Creatures" folder.',
        inputSchema: {
          type: 'object',
          properties: {
            // --- Identity ---
            name: {
              type: 'string',
              description: 'Name of the NPC',
            },
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
              description: 'Creature type',
            },
            creatureSubtype: {
              type: 'string',
              description: 'Optional subtype (e.g. "Goblinoid", "Shapechanger")',
              default: '',
            },
            size: {
              type: 'string',
              enum: ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'],
              description: 'Creature size',
            },
            alignment: {
              type: 'string',
              description: 'Alignment string (e.g. "Neutral Evil", "Chaotic Good")',
              default: '',
            },
            cr: {
              description:
                'Challenge Rating — whole number (0, 1, 5), fraction string ("1/8", "1/4", "1/2"), ' +
                'or decimal number (0.25, 0.5)',
              oneOf: [
                { type: 'string', pattern: '^\\d+(\\/[248])?$' },
                { type: 'number', minimum: 0 },
              ],
            },
            // --- HP ---
            hpAverage: {
              type: 'number',
              description: 'Average (fixed) hit points',
              minimum: 1,
            },
            hpFormula: {
              type: 'string',
              description: 'Hit dice formula used for re-rolls (e.g. "2d6", "3d8+9")',
            },
            // --- AC ---
            acMode: {
              type: 'string',
              enum: ['default', 'flat'],
              description:
                '"default" — Foundry calculates AC from equipped items and abilities; ' +
                '"flat" — set a fixed AC value via acValue',
            },
            acValue: {
              type: 'number',
              description: 'Fixed AC value (0–30). Required when acMode is "flat".',
              minimum: 0,
              maximum: 30,
            },
            // --- Ability scores ---
            abilities: {
              type: 'object',
              description: 'The six ability scores (1–30 each)',
              properties: {
                str: { type: 'number', minimum: 1, maximum: 30 },
                dex: { type: 'number', minimum: 1, maximum: 30 },
                con: { type: 'number', minimum: 1, maximum: 30 },
                int: { type: 'number', minimum: 1, maximum: 30 },
                wis: { type: 'number', minimum: 1, maximum: 30 },
                cha: { type: 'number', minimum: 1, maximum: 30 },
              },
              required: ['str', 'dex', 'con', 'int', 'wis', 'cha'],
            },
            // --- Saving throws ---
            savingThrows: {
              type: 'array',
              description: 'Abilities with saving throw proficiency',
              items: {
                type: 'string',
                enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'],
              },
              default: [],
            },
            // --- Movement ---
            walkSpeed: {
              type: 'number',
              description: 'Walk speed in feet',
              minimum: 0,
              default: 30,
            },
            flySpeed: {
              type: 'number',
              description: 'Fly speed in feet',
              minimum: 0,
              default: 0,
            },
            swimSpeed: {
              type: 'number',
              description: 'Swim speed in feet',
              minimum: 0,
              default: 0,
            },
            climbSpeed: {
              type: 'number',
              description: 'Climb speed in feet',
              minimum: 0,
              default: 0,
            },
            burrowSpeed: {
              type: 'number',
              description: 'Burrow speed in feet',
              minimum: 0,
              default: 0,
            },
            hover: {
              type: 'boolean',
              description: 'Whether the creature hovers (cannot fall)',
              default: false,
            },
            // --- Senses ---
            darkvision: {
              type: 'number',
              description: 'Darkvision range in feet',
              minimum: 0,
              default: 0,
            },
            blindsight: {
              type: 'number',
              description: 'Blindsight range in feet',
              minimum: 0,
              default: 0,
            },
            tremorsense: {
              type: 'number',
              description: 'Tremorsense range in feet',
              minimum: 0,
              default: 0,
            },
            truesight: {
              type: 'number',
              description: 'Truesight range in feet',
              minimum: 0,
              default: 0,
            },
            specialSenses: {
              type: 'string',
              description: 'Any additional senses not covered by the standard fields',
              default: '',
            },
            // --- Skills ---
            skills: {
              type: 'array',
              description: 'Skills with proficiency or expertise',
              items: {
                type: 'object',
                properties: {
                  skill: {
                    type: 'string',
                    enum: [
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
                    ],
                  },
                  proficiency: {
                    type: 'string',
                    enum: ['proficient', 'expert'],
                    description:
                      '"proficient" = proficiency bonus once; "expert" = double proficiency',
                  },
                },
                required: ['skill', 'proficiency'],
              },
              default: [],
            },
            // --- Damage traits ---
            damageImmunities: {
              type: 'array',
              description:
                'Damage types the creature is immune to (e.g. ["necrotic", "poison"]). ' +
                'Canonical values: acid, bludgeoning, cold, fire, force, lightning, necrotic, ' +
                'piercing, poison, psychic, radiant, slashing, thunder. ' +
                'Non-canonical values are accepted with a warning.',
              items: { type: 'string' },
              default: [],
            },
            damageResistances: {
              type: 'array',
              description:
                'Damage types the creature is resistant to. Same canonical set as damageImmunities.',
              items: { type: 'string' },
              default: [],
            },
            damageVulnerabilities: {
              type: 'array',
              description:
                'Damage types the creature is vulnerable to. Same canonical set as damageImmunities.',
              items: { type: 'string' },
              default: [],
            },
            conditionImmunities: {
              type: 'array',
              description:
                'Conditions the creature is immune to (e.g. ["charmed", "frightened"]). ' +
                'Canonical values: blinded, charmed, deafened, exhaustion, frightened, grappled, ' +
                'incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, ' +
                'stunned, unconscious. Non-canonical values are accepted with a warning.',
              items: { type: 'string' },
              default: [],
            },
            // --- Languages ---
            languages: {
              type: 'array',
              description: 'Languages the creature speaks (e.g. ["Common", "Goblin"])',
              items: { type: 'string' },
              default: [],
            },
            languagesCustom: {
              type: 'string',
              description: 'Free-text language note (e.g. "telepathy 60 ft.")',
              default: '',
            },
            // --- Biography & source ---
            biography: {
              type: 'string',
              description: 'HTML biography text shown in the character sheet',
              default: '',
            },
            sourceBook: {
              type: 'string',
              description: 'Source book abbreviation (e.g. "MM\'14", "VGM")',
              default: '',
            },
            sourcePage: {
              type: 'string',
              description: 'Page number in the source book',
              default: '',
            },
            sourceRules: {
              type: 'string',
              enum: ['2014', '2024'],
              description: 'Rules edition',
              default: '2014',
            },
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
