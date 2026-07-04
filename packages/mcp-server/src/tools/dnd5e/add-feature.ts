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

const ATTACK_PROPERTY_CANONICAL = new Set([
  'ada',
  'amm',
  'fin',
  'fir',
  'foc',
  'hvy',
  'lgt',
  'lod',
  'mgc',
  'rch',
  'ret',
  'spc',
  'thr',
  'two',
  'ver',
]);

const CLASS_DEFAULT_ABILITY: Record<string, string> = {
  wizard: 'int',
  artificer: 'int',
  cleric: 'wis',
  druid: 'wis',
  ranger: 'wis',
  sorcerer: 'cha',
  warlock: 'cha',
  bard: 'cha',
  paladin: 'cha',
};

// ---------------------------------------------------------------------------
// Shared Zod building blocks
// ---------------------------------------------------------------------------

const damagePart = z.object({
  number: z.number().int().min(1),
  denomination: z
    .number()
    .int()
    .refine(d => [4, 6, 8, 10, 12, 20, 100].includes(d), {
      message: 'denomination must be one of 4, 6, 8, 10, 12, 20, 100',
    }),
  type: z.string().min(1, 'damage type cannot be empty'),
});

const damagePartSchema = {
  type: 'object',
  properties: {
    number: { type: 'number', description: 'Number of dice (e.g. 4)', minimum: 1 },
    denomination: { type: 'number', description: 'Die size', enum: [4, 6, 8, 10, 12, 20, 100] },
    type: { type: 'string', description: 'Damage type (e.g. "fire", "slashing", "cold")' },
  },
  required: ['number', 'denomination', 'type'],
};

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface DnD5eAddFeatureToolOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DnD5eAddFeatureTool {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;

  constructor({ foundryClient, logger }: DnD5eAddFeatureToolOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DnD5eAddFeatureTool' });
    this.errorHandler = new ErrorHandler(this.logger);
  }

  getToolDefinitions() {
    const ability = { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] };
    return [
      {
        name: 'dnd5e-add-feature',
        description:
          '[D&D 5e] Add a feature/attack/spellcasting/spells to an actor. featureType selects the mode and its params: ' +
          'passive{featureName}; save{featureName,saveAbility,saveDC,damageParts, +halfOnSave,areaType,areaSize}; ' +
          'attack{featureName,attackType,damageParts, rangeFt if ranged, +weaponClass,abilityModifier,attackBonus,reachFt,properties}; ' +
          'attack-with-save{attack params + saveAbility,saveDC,saveDamageParts,saveOnSave}; ' +
          'aura{featureName,damageParts,areaType,areaSize} (auto damage, no save); ' +
          'spellcasting{spellcastingClass,spellcastingLevel, +spellcastingAbility} (run BEFORE spells); ' +
          'spells{spellNames, +compendiumPacks}. All modes need actorIdentifier.',
        inputSchema: {
          type: 'object',
          properties: {
            featureType: {
              type: 'string',
              enum: [
                'passive',
                'save',
                'attack',
                'attack-with-save',
                'aura',
                'spellcasting',
                'spells',
              ],
            },
            actorIdentifier: { type: 'string', description: 'Actor name or id' },
            featureName: { type: 'string' },
            description: { type: 'string', description: 'HTML body', default: '' },
            activationType: {
              type: 'string',
              enum: ['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'],
              default: 'action',
            },
            damageParts: {
              type: 'array',
              minItems: 1,
              items: damagePartSchema,
            },
            saveAbility: ability,
            saveDC: { type: 'number', minimum: 1, maximum: 30 },
            halfOnSave: { type: 'boolean', default: true },
            saveDamageParts: { type: 'array', minItems: 1, items: damagePartSchema },
            saveOnSave: { type: 'string', enum: ['half', 'none'], default: 'none' },
            areaType: {
              type: 'string',
              enum: ['cone', 'cube', 'cylinder', 'emanation', 'line', 'radius', 'sphere', ''],
              default: '',
            },
            areaSize: { type: 'number', exclusiveMinimum: 0, description: 'e.g. 30 for 30ft cone' },
            areaUnits: { type: 'string', enum: ['ft', 'm'], default: 'ft' },
            affectsType: {
              type: 'string',
              enum: ['creature', 'object', 'space', ''],
              default: 'creature',
            },
            attackType: { type: 'string', enum: ['melee', 'ranged'] },
            weaponClass: {
              type: 'string',
              enum: ['natural', 'simpleM', 'martialM', 'simpleR', 'martialR'],
              default: 'natural',
            },
            abilityModifier: { ...ability, description: 'default STR melee / DEX ranged' },
            attackBonus: {
              type: 'number',
              minimum: 0,
              maximum: 10,
              default: 0,
              description: 'to-hit only',
            },
            proficient: { type: 'boolean', default: true },
            equipped: { type: 'boolean', default: true },
            reachFt: { type: 'number', minimum: 5, default: 5 },
            rangeFt: { type: 'number', minimum: 1 },
            longRangeFt: { type: 'number', minimum: 1 },
            properties: {
              type: 'array',
              items: { type: 'string' },
              default: [],
              description: 'codes: ada amm fin fir foc hvy lgt lod mgc rch ret spc thr two ver',
            },
            spellcastingClass: {
              type: 'string',
              enum: [
                'artificer',
                'bard',
                'cleric',
                'druid',
                'paladin',
                'ranger',
                'sorcerer',
                'warlock',
                'wizard',
              ],
            },
            spellcastingLevel: { type: 'number', minimum: 1, maximum: 20 },
            spellcastingAbility: { ...ability, description: 'default per class' },
            spellNames: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: { type: 'string', minLength: 1 },
            },
            compendiumPacks: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              default: ['dnd5e.spells'],
            },
            sourceRules: { type: 'string', enum: ['2014', '2024'], default: '2014' },
            sourceBook: { type: 'string', default: '' },
            sourcePage: { type: 'string', default: '' },
          },
          required: ['featureType', 'actorIdentifier'],
        },
      },
    ];
  }
  // ---------------------------------------------------------------------------
  // Master dispatcher
  // ---------------------------------------------------------------------------

  async handleAddFeature(args: any): Promise<any> {
    const { featureType } = z
      .object({
        featureType: z.enum([
          'passive',
          'save',
          'attack',
          'attack-with-save',
          'aura',
          'spellcasting',
          'spells',
        ]),
      })
      .parse(args);

    switch (featureType) {
      case 'passive':
        return this.handlePassive(args);
      case 'save':
        return this.handleSave(args);
      case 'attack':
        return this.handleAttack(args);
      case 'attack-with-save':
        return this.handleAttackWithSave(args);
      case 'aura':
        return this.handleAura(args);
      case 'spellcasting':
        return this.handleSpellcasting(args);
      case 'spells':
        return this.handleSpells(args);
    }
  }

  // ---------------------------------------------------------------------------
  // passive
  // ---------------------------------------------------------------------------

  private async handlePassive(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('passive'),
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      featureName: z.string().min(1, 'featureName cannot be empty'),
      description: z.string().default(''),
      sourceRules: z.enum(['2014', '2024']).default('2014'),
      sourceBook: z.string().default(''),
      sourcePage: z.string().default(''),
    });

    const parsed = schema.parse(args);

    this.logger.info('Adding passive feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (passive) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query(
        'foundry-mcp-bridge.addPassiveFeatureToActor',
        parsed
      );

      this.logger.info('Passive feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatPassiveResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'passive feature creation');
    }
  }

  private formatPassiveResponse(result: any, params: any): any {
    const summary = `✅ Feature "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Feature:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Type:** passive / descriptive (no activity)`,
      `**Rules:** ${params.sourceRules}${params.sourceBook ? ` — ${params.sourceBook}` : ''}`,
    ].join('\n');
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      message: `${summary}\n\n${details}`,
    };
  }

  // ---------------------------------------------------------------------------
  // save
  // ---------------------------------------------------------------------------

  private async handleSave(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('save'),
        actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
        featureName: z.string().min(1, 'featureName cannot be empty'),
        description: z.string().default(''),
        activationType: z
          .enum(['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'])
          .default('action'),
        saveAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']),
        saveDC: z.number().int().min(1).max(30),
        damageParts: z.array(damagePart).min(1, 'at least one damage part is required'),
        halfOnSave: z.boolean().default(true),
        areaType: z
          .enum(['cone', 'cube', 'cylinder', 'emanation', 'line', 'radius', 'sphere', ''])
          .default(''),
        areaSize: z.number().positive().optional(),
        areaUnits: z.enum(['ft', 'm']).default('ft'),
        affectsType: z.enum(['creature', 'object', 'space', '']).default('creature'),
      })
      .superRefine((data, ctx) => {
        if (data.areaType !== '' && data.areaSize === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['areaSize'],
            message: `areaSize is required when areaType is "${data.areaType}"`,
          });
        }
      });

    const parsed = schema.parse(args);

    this.logger.info('Adding save feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      saveAbility: parsed.saveAbility,
      saveDC: parsed.saveDC,
      areaType: parsed.areaType || 'none',
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (save) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query(
        'foundry-mcp-bridge.addSaveFeatureToActor',
        parsed
      );

      this.logger.info('Save feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatSaveResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'save feature creation');
    }
  }

  private formatSaveResponse(result: any, params: any): any {
    const damageDesc = (params.damageParts as any[])
      .map(p => `${p.number}d${p.denomination} ${p.type}`)
      .join(' + ');
    const areaDesc = params.areaType
      ? `, ${params.areaSize}${params.areaUnits} ${params.areaType}`
      : '';
    const saveDesc = `DC ${params.saveDC} ${String(params.saveAbility).toUpperCase()} save`;
    const onSaveDesc = params.halfOnSave ? 'half damage on save' : 'no damage on save';
    const summary = `✅ Feature "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Feature:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Save:** ${saveDesc} — ${onSaveDesc}`,
      `**Damage:** ${damageDesc}${areaDesc}`,
      `**Activation:** ${params.activationType}`,
    ].join('\n');
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      message: `${summary}\n\n${details}`,
    };
  }

  // ---------------------------------------------------------------------------
  // attack
  // ---------------------------------------------------------------------------

  private async handleAttack(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('attack'),
        actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
        featureName: z.string().min(1, 'featureName cannot be empty'),
        description: z.string().default(''),
        activationType: z
          .enum(['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'])
          .default('action'),
        attackType: z.enum(['melee', 'ranged']),
        weaponClass: z
          .enum(['natural', 'simpleM', 'martialM', 'simpleR', 'martialR'])
          .default('natural'),
        abilityModifier: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
        attackBonus: z.number().int().min(0).max(10).default(0),
        proficient: z.boolean().default(true),
        equipped: z.boolean().default(true),
        reachFt: z.number().int().min(5).default(5),
        rangeFt: z.number().int().min(1).optional(),
        longRangeFt: z.number().int().min(1).optional(),
        damageParts: z.array(damagePart).min(1, 'at least one damage part is required'),
        properties: z.array(z.string()).default([]),
        sourceRules: z.enum(['2014', '2024']).default('2014'),
        sourceBook: z.string().default(''),
        sourcePage: z.string().default(''),
      })
      .superRefine((data, ctx) => {
        if (data.attackType === 'ranged' && data.rangeFt === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rangeFt'],
            message: 'rangeFt is required when attackType is "ranged"',
          });
        }
        if (
          data.longRangeFt !== undefined &&
          data.rangeFt !== undefined &&
          data.longRangeFt <= data.rangeFt
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['longRangeFt'],
            message: `longRangeFt (${data.longRangeFt}) must be greater than rangeFt (${data.rangeFt})`,
          });
        }
      });

    const parsed = schema.parse(args);
    const effectiveAbility: string =
      parsed.abilityModifier ?? (parsed.attackType === 'melee' ? 'str' : 'dex');

    const warnings: string[] = [];
    for (const part of parsed.damageParts) {
      if (!DAMAGE_CANONICAL.has(part.type)) {
        const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { value: part.type });
      }
    }
    for (const prop of parsed.properties) {
      if (!ATTACK_PROPERTY_CANONICAL.has(prop)) {
        const msg = `Unknown weapon property "${prop}" — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { value: prop });
      }
    }

    this.logger.info('Adding attack feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      attackType: parsed.attackType,
      ability: effectiveAbility,
      warnings: warnings.length,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (attack) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.addAttackToActor', {
        ...parsed,
        effectiveAbility,
      });

      this.logger.info('Attack feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatAttackResponse(result, { ...parsed, effectiveAbility }, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'attack feature creation');
    }
  }

  private formatAttackResponse(result: any, params: any, warnings: string[]): any {
    const bonusStr = params.attackBonus > 0 ? ` +${params.attackBonus} to hit` : '';
    const damageDesc = (params.damageParts as any[])
      .map(p => `${p.number}d${p.denomination} ${p.type}`)
      .join(' + ');
    const rangeDesc =
      params.attackType === 'melee'
        ? `reach ${params.reachFt ?? 5} ft.`
        : `range ${params.rangeFt}${params.longRangeFt ? `/${params.longRangeFt}` : ''} ft.`;
    const summary = `✅ Attack "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Item:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Attack:** ${params.attackType} — ${String(params.effectiveAbility).toUpperCase()} modifier${bonusStr}`,
      `**Damage:** ${damageDesc}`,
      `**Range/Reach:** ${rangeDesc}`,
      `**Weapon class:** ${params.weaponClass}`,
    ].join('\n');
    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
        : '';
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // attack-with-save
  // ---------------------------------------------------------------------------

  private async handleAttackWithSave(args: any): Promise<any> {
    const schema = z
      .object({
        featureType: z.literal('attack-with-save'),
        actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
        featureName: z.string().min(1, 'featureName cannot be empty'),
        description: z.string().default(''),
        activationType: z
          .enum(['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'])
          .default('action'),
        attackType: z.enum(['melee', 'ranged']),
        weaponClass: z
          .enum(['natural', 'simpleM', 'martialM', 'simpleR', 'martialR'])
          .default('natural'),
        abilityModifier: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
        attackBonus: z.number().int().min(0).max(10).default(0),
        proficient: z.boolean().default(true),
        equipped: z.boolean().default(true),
        reachFt: z.number().int().min(5).default(5),
        rangeFt: z.number().int().min(1).optional(),
        longRangeFt: z.number().int().min(1).optional(),
        damageParts: z.array(damagePart).min(1, 'at least one damage part is required'),
        properties: z.array(z.string()).default([]),
        saveAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']),
        saveDC: z.number().int().min(1).max(30),
        saveDamageParts: z.array(damagePart).min(1, 'at least one save damage part is required'),
        saveOnSave: z.enum(['half', 'none']).default('none'),
        sourceRules: z.enum(['2014', '2024']).default('2014'),
        sourceBook: z.string().default(''),
        sourcePage: z.string().default(''),
      })
      .superRefine((data, ctx) => {
        if (data.attackType === 'ranged' && data.rangeFt === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rangeFt'],
            message: 'rangeFt is required when attackType is "ranged"',
          });
        }
        if (
          data.longRangeFt !== undefined &&
          data.rangeFt !== undefined &&
          data.longRangeFt <= data.rangeFt
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['longRangeFt'],
            message: `longRangeFt (${data.longRangeFt}) must be greater than rangeFt (${data.rangeFt})`,
          });
        }
      });

    const parsed = schema.parse(args);
    const effectiveAbility: string =
      parsed.abilityModifier ?? (parsed.attackType === 'melee' ? 'str' : 'dex');

    const warnings: string[] = [];
    for (const part of [...parsed.damageParts, ...parsed.saveDamageParts]) {
      if (!DAMAGE_CANONICAL.has(part.type)) {
        const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
        if (!warnings.includes(msg)) warnings.push(msg);
        this.logger.warn(msg, { value: part.type });
      }
    }

    this.logger.info('Adding attack+save feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      attackType: parsed.attackType,
      saveAbility: parsed.saveAbility,
      saveDC: parsed.saveDC,
      warnings: warnings.length,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (attack-with-save) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.addAttackWithSaveToActor', {
        ...parsed,
        effectiveAbility,
      });

      this.logger.info('Attack+save feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatAttackWithSaveResponse(result, { ...parsed, effectiveAbility }, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'attack+save feature creation');
    }
  }

  private formatAttackWithSaveResponse(result: any, params: any, warnings: string[]): any {
    const bonusStr = params.attackBonus > 0 ? ` +${params.attackBonus} to hit` : '';
    const attackDamageDesc = (params.damageParts as any[])
      .map(p => `${p.number}d${p.denomination} ${p.type}`)
      .join(' + ');
    const saveDamageDesc = (params.saveDamageParts as any[])
      .map(p => `${p.number}d${p.denomination} ${p.type}`)
      .join(' + ');
    const rangeDesc =
      params.attackType === 'melee'
        ? `reach ${params.reachFt ?? 5} ft.`
        : `range ${params.rangeFt}${params.longRangeFt ? `/${params.longRangeFt}` : ''} ft.`;
    const summary = `✅ Attack+Save "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Item:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Attack:** ${params.attackType} — ${String(params.effectiveAbility).toUpperCase()} modifier${bonusStr}, ${rangeDesc}`,
      `**Attack damage:** ${attackDamageDesc}`,
      `**Save:** DC ${params.saveDC} ${String(params.saveAbility).toUpperCase()} — ${saveDamageDesc} (${params.saveOnSave === 'half' ? 'half on save' : 'no damage on save'})`,
    ].join('\n');
    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
        : '';
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // aura
  // ---------------------------------------------------------------------------

  private async handleAura(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('aura'),
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      featureName: z.string().min(1, 'featureName cannot be empty'),
      description: z.string().default(''),
      activationType: z
        .enum(['action', 'bonus', 'reaction', 'legendary', 'lair', 'special'])
        .default('action'),
      damageParts: z.array(damagePart).min(1, 'at least one damage part is required'),
      areaType: z.enum(['cone', 'cube', 'cylinder', 'emanation', 'line', 'radius', 'sphere']),
      areaSize: z.number().positive('areaSize must be greater than 0'),
      areaUnits: z.enum(['ft', 'm']).default('ft'),
      affectsType: z.enum(['creature', 'object', 'space', '']).default('creature'),
      sourceRules: z.enum(['2014', '2024']).default('2014'),
      sourceBook: z.string().default(''),
      sourcePage: z.string().default(''),
    });

    const parsed = schema.parse(args);

    const warnings: string[] = [];
    for (const part of parsed.damageParts) {
      if (!DAMAGE_CANONICAL.has(part.type)) {
        const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
        warnings.push(msg);
        this.logger.warn(msg, { value: part.type });
      }
    }

    this.logger.info('Adding aura feature to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      featureName: parsed.featureName,
      areaType: parsed.areaType,
      areaSize: parsed.areaSize,
      warnings: warnings.length,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (aura) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.addAuraToActor', parsed);

      this.logger.info('Aura feature added successfully', {
        actorId: result.actor?.id,
        itemId: result.item?.id,
      });

      return this.formatAuraResponse(result, parsed, warnings);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'aura feature creation');
    }
  }

  private formatAuraResponse(result: any, params: any, warnings: string[]): any {
    const damageDesc = (params.damageParts as any[])
      .map(p => `${p.number}d${p.denomination} ${p.type}`)
      .join(' + ');
    const areaDesc = `${params.areaSize}${params.areaUnits} ${params.areaType}`;
    const summary = `✅ Aura "${result.item.name}" added to "${result.actor.name}"`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Feature:** ${result.item.name} (id: \`${result.item.id}\`)`,
      `**Damage:** ${damageDesc} (automatic — no attack roll, no saving throw)`,
      `**Area:** ${areaDesc}, affects: ${params.affectsType || 'any'}`,
      `**Activation:** ${params.activationType}`,
    ].join('\n');
    const warningSection =
      warnings.length > 0
        ? `\n\n⚠️ **Warnings (${warnings.length}):**\n${warnings.map(w => `- ${w}`).join('\n')}`
        : '';
    return {
      summary,
      success: true,
      item: result.item,
      actor: result.actor,
      warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // spellcasting
  // ---------------------------------------------------------------------------

  private async handleSpellcasting(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('spellcasting'),
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      spellcastingClass: z.enum([
        'artificer',
        'bard',
        'cleric',
        'druid',
        'paladin',
        'ranger',
        'sorcerer',
        'warlock',
        'wizard',
      ]),
      spellcastingLevel: z.number().int().min(1).max(20),
      spellcastingAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
      sourceRules: z.enum(['2014', '2024']).default('2014'),
    });

    const parsed = schema.parse(args);
    const effectiveAbility =
      parsed.spellcastingAbility ?? CLASS_DEFAULT_ABILITY[parsed.spellcastingClass];

    this.logger.info('Setting actor spellcasting', {
      actorIdentifier: parsed.actorIdentifier,
      spellcastingClass: parsed.spellcastingClass,
      spellcastingLevel: parsed.spellcastingLevel,
      ability: effectiveAbility,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (spellcasting) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.setActorSpellcasting', {
        ...parsed,
        effectiveAbility,
      });

      this.logger.info('Actor spellcasting set successfully', { actorId: result.actor?.id });

      return this.formatSpellcastingResponse(result, { ...parsed, effectiveAbility });
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'spellcasting setup');
    }
  }

  private formatSpellcastingResponse(result: any, params: any): any {
    const isWarlock = params.spellcastingClass === 'warlock';
    const slotsDesc = isWarlock
      ? `Pact Magic: ${result.spellcasting.slots.pact.max} slot(s) of level ${result.spellcasting.slots.pact.level}`
      : Object.entries(result.spellcasting.slots as Record<string, number>)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `L${k.replace('spell', '')}: ${n}`)
          .join(', ') || 'no slots';
    const summary = `✅ Spellcasting configured on "${result.actor.name}" — ${params.spellcastingClass} level ${params.spellcastingLevel}`;
    const details = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Class:** ${params.spellcastingClass} — level ${params.spellcastingLevel}`,
      `**Ability:** ${String(params.effectiveAbility).toUpperCase()}`,
      `**Slots:** ${slotsDesc}`,
    ].join('\n');
    const warningSection =
      (result.warnings as string[]).length > 0
        ? `\n\n⚠️ **Warnings:**\n${(result.warnings as string[]).map((w: string) => `- ${w}`).join('\n')}`
        : '';
    return {
      summary,
      success: true,
      actor: result.actor,
      spellcasting: result.spellcasting,
      warnings: result.warnings,
      message: `${summary}\n\n${details}${warningSection}`,
    };
  }

  // ---------------------------------------------------------------------------
  // spells
  // ---------------------------------------------------------------------------

  private async handleSpells(args: any): Promise<any> {
    const schema = z.object({
      featureType: z.literal('spells'),
      actorIdentifier: z.string().min(1, 'actorIdentifier cannot be empty'),
      spellNames: z.array(z.string().min(1)).min(1).max(50),
      compendiumPacks: z.array(z.string().min(1)).default(['dnd5e.spells']),
    });

    const parsed = schema.parse(args);

    this.logger.info('Adding spells to D&D 5e actor', {
      actorIdentifier: parsed.actorIdentifier,
      spellCount: parsed.spellNames.length,
      packs: parsed.compendiumPacks,
    });

    try {
      const system = await detectGameSystem(this.foundryClient, this.logger);
      if (system !== 'dnd5e') {
        throw new Error(
          `dnd5e-add-feature (spells) requires D&D 5e. ` +
            `Detected system: "${getCachedSystemId() ?? 'unknown'}".`
        );
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.addSpellsToActor', parsed);

      this.logger.info('Spells import complete', {
        actorId: result.actor?.id,
        added: result.added?.length,
        skipped: result.skipped?.length,
        notFound: result.notFound?.length,
        failed: result.failed?.length,
      });

      return this.formatSpellsResponse(result, parsed);
    } catch (error) {
      this.errorHandler.handleToolError(error, 'dnd5e-add-feature', 'spell import');
    }
  }

  private formatSpellsResponse(result: any, params: any): any {
    const added = result.added as Array<{
      name: string;
      packId: string;
      packLabel: string;
      itemId: string;
    }>;
    const skipped = result.skipped as Array<{ name: string; reason: string }>;
    const notFound = result.notFound as string[];
    const failed = result.failed as Array<{ name: string; error: string }>;
    const warnings = result.warnings as string[];
    const total = (params.spellNames as string[]).length;

    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} added`);
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (notFound.length > 0) parts.push(`${notFound.length} not found`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);

    const icon = failed.length > 0 ? '⚠️' : notFound.length > 0 ? '🔍' : '✅';
    const summary = `${icon} Spells imported to "${result.actor.name}" — ${parts.length > 0 ? parts.join(', ') : 'nothing changed'}`;

    const lines: string[] = [
      `**Actor:** ${result.actor.name} (id: \`${result.actor.id}\`)`,
      `**Requested:** ${total} — Added: ${added.length}, Skipped: ${skipped.length}, Not found: ${notFound.length}${failed.length > 0 ? `, Failed: ${failed.length}` : ''}`,
    ];
    if (added.length > 0) {
      lines.push('\n✅ **Added:**');
      for (const s of added) lines.push(`  - ${s.name} *(${s.packLabel}, item \`${s.itemId}\`)*`);
    }
    if (skipped.length > 0) {
      lines.push('\n⏭️ **Skipped:**');
      for (const s of skipped) lines.push(`  - ${s.name} — *${s.reason}*`);
    }
    if (notFound.length > 0) {
      lines.push('\n❌ **Not found in compendium:**');
      for (const name of notFound) lines.push(`  - ${name}`);
    }
    if (failed.length > 0) {
      lines.push('\n⚠️ **Failed during import:**');
      for (const f of failed) lines.push(`  - ${f.name} — *${f.error}*`);
    }
    if (warnings.length > 0) {
      lines.push('\n⚠️ **Warnings:**');
      for (const w of warnings) lines.push(`  - ${w}`);
    }
    return {
      summary,
      success: added.length > 0 || (notFound.length === 0 && failed.length === 0),
      actor: result.actor,
      added,
      skipped,
      notFound,
      failed,
      warnings,
      message: `${summary}\n\n${lines.join('\n')}`,
    };
  }
}
