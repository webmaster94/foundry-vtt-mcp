/**
 * WFRP4e Adapter Tests
 *
 * Validates character-stat extraction against a representative WFRP4e
 * `character` actor (source-style data, i.e. characteristic `value`/`bonus`
 * not yet derived) plus adapter metadata and filtering.
 */

import { describe, it, expect } from 'vitest';
import { WFRP4eAdapter } from './adapter.js';

/**
 * Representative WFRP4e player character. Characteristics intentionally omit
 * the derived `value`/`bonus` to exercise the adapter's fallback math
 * (value = initial + modifier + advances; bonus = floor(value / 10)).
 */
const boris: any = {
  name: 'Boris Dorchen',
  type: 'character',
  img: 'icons/svg/mystery-man.svg',
  system: {
    characteristics: {
      ws: { initial: 30, modifier: -10, advances: 10 }, // value 30 (30 - 10 + 10), bonus 3
      bs: { initial: 30, modifier: 0, advances: 5 },
      s: { initial: 35, modifier: 0, advances: 0 },
      t: { initial: 35, modifier: 0, advances: 5 },
      i: { initial: 30, modifier: 0, advances: 0 },
      ag: { initial: 30, modifier: 0, advances: 0 },
      dex: { initial: 30, modifier: 0, advances: 0 },
      int: { initial: 30, modifier: 0, advances: 0 },
      wp: { initial: 30, modifier: 0, advances: 5 },
      fel: { initial: 30, modifier: 0, advances: 0 },
    },
    status: {
      wounds: { value: 12, max: 14 },
      advantage: { value: 1, max: 4 },
      fate: { value: 3 },
      fortune: { value: 2 },
      resilience: { value: 2 },
      resolve: { value: 1 },
      corruption: { value: 0, max: 3 },
      criticalWounds: { value: 0, max: 4 },
    },
    details: {
      species: { value: 'Human', subspecies: 'Reiklander' },
      career: { value: 'Huntsman' },
      class: { value: 'Ranger' },
      status: { standing: 2, tier: 'silver', value: 'Silver 2' },
      move: { value: 4, walk: 8, run: 16 },
      size: { value: 'avg' },
      experience: { total: 1000, spent: 800, current: 200 },
    },
  },
  items: [
    { type: 'spell', name: 'Dart', system: { lore: { value: ['fire'] }, cn: { value: 0 } } },
    { type: 'prayer', name: 'Bless (Sigmar)', system: { god: { value: 'Sigmar' } } },
    { type: 'weapon', name: 'Hunting Bow' },
    // Skill with a system-derived total (preferred verbatim): Ag 30 + 15 advances = 45.
    {
      type: 'skill',
      name: 'Stealth (Rural)',
      system: {
        characteristic: { value: 'ag' },
        advances: { value: 15 },
        modifier: { value: 0 },
        total: { value: 45 },
      },
    },
    // Skill WITHOUT a derived total: must fall back to BS 35 + 10 advances = 45.
    {
      type: 'skill',
      name: 'Ranged (Bow)',
      system: {
        characteristic: { value: 'bs' },
        advances: { value: 10 },
        modifier: { value: 0 },
      },
    },
  ],
};

describe('WFRP4eAdapter metadata', () => {
  const adapter = new WFRP4eAdapter();

  it('identifies as wfrp4e and handles the system id', () => {
    expect(adapter.getMetadata().id).toBe('wfrp4e');
    expect(adapter.canHandle('wfrp4e')).toBe(true);
    expect(adapter.canHandle('WFRP4E')).toBe(true);
    expect(adapter.canHandle('dnd5e')).toBe(false);
  });

  it('reports character-focused feature support', () => {
    const features = adapter.getMetadata().supportedFeatures;
    expect(features.characterStats).toBe(true);
    expect(features.spellcasting).toBe(true);
    expect(features.creatureIndex).toBe(false);
    expect(features.powerLevel).toBe(false);
  });
});

describe('WFRP4eAdapter.extractCharacterStats', () => {
  const stats = new WFRP4eAdapter().extractCharacterStats(boris);

  it('keeps identifying info', () => {
    expect(stats.name).toBe('Boris Dorchen');
    expect(stats.type).toBe('character');
  });

  it('derives characteristic value and bonus when not pre-computed', () => {
    expect(stats.characteristics.T.value).toBe(40);
    expect(stats.characteristics.Fel.value).toBe(30);
    expect(stats.characteristics.Fel.bonus).toBe(3);
    // All 10 characteristics present
    expect(Object.keys(stats.characteristics)).toHaveLength(10);
  });

  it('surfaces the modifier so Total reconciles (Total = initial + advances + modifier)', () => {
    const ws = stats.characteristics.WS;
    // 30 initial + 10 advances + (-10 modifier) = 30 Total
    expect(ws).toMatchObject({
      initial: 30,
      advances: 10,
      modifier: -10,
      value: 30,
      bonus: 3,
      name: 'Weapon Skill',
    });
    expect(ws.initial + ws.advances + ws.modifier).toBe(ws.value);
    // Characteristics without a modifier report modifier: 0 (not undefined)
    expect(stats.characteristics.T.modifier).toBe(0);
  });

  it('extracts wounds and advantage', () => {
    expect(stats.wounds).toEqual({ value: 12, max: 14 });
    expect(stats.advantage).toEqual({ value: 1, max: 4 });
  });

  it('extracts fate/fortune and resilience/resolve', () => {
    expect(stats.fate).toEqual({ fate: 3, fortune: 2 });
    expect(stats.resilience).toEqual({ resilience: 2, resolve: 1 });
  });

  it('extracts identity (species, subspecies, career, class, status)', () => {
    expect(stats.identity).toMatchObject({
      species: 'Human',
      subspecies: 'Reiklander',
      career: 'Huntsman',
      class: 'Ranger',
      status: 'Silver 2',
    });
  });

  it('normalizes size and reports experience', () => {
    expect(stats.size).toBe('average');
    expect(stats.experience).toEqual({ total: 1000, spent: 800, current: 200 });
  });

  it('detects arcane spells and divine prayers from items', () => {
    expect(stats.spellcasting).toEqual({ hasSpells: true, hasPrayers: true });
  });

  it('reports skill totals (characteristic + advances), not advances alone', () => {
    const stealth = stats.skills.find((s: any) => s.name === 'Stealth (Rural)');
    const bow = stats.skills.find((s: any) => s.name === 'Ranged (Bow)');

    // Uses the system-derived total verbatim when present.
    expect(stealth).toMatchObject({ total: 45, advances: 15, characteristic: 'Ag' });

    // Falls back to linked-characteristic value + advances when total is absent:
    // BS value 35 (initial 30 + 5 advances) + 10 skill advances = 45 (NOT 10).
    expect(bow).toMatchObject({ total: 45, advances: 10, characteristic: 'BS' });
  });
});

describe('WFRP4eAdapter.extractBasicInfo', () => {
  const basic = new WFRP4eAdapter().extractBasicInfo(boris);

  it('maps wounds to hitPoints and surfaces movement', () => {
    expect(basic.hitPoints).toEqual({ current: 12, max: 14 });
    expect(basic.movement).toBe(4);
  });

  it('does not invent an armour class (WFRP4e has none)', () => {
    expect(basic.armorClass).toBeUndefined();
  });
});

describe('WFRP4eAdapter career resolution', () => {
  const adapter = new WFRP4eAdapter();

  it('reads the current career from the career item, ignoring a circular details.career', () => {
    // In derived data details.career is the career item, which the browser
    // sanitizes to "[Circular Reference]"; the current career item is the
    // reliable source.
    const a = {
      name: 'Tylo',
      type: 'character',
      system: { details: { career: '[Circular Reference]' } },
      items: [
        { type: 'career', name: 'Old Career', system: { current: { value: false } } },
        { type: 'career', name: 'Hedge Apprentice', system: { current: { value: true } } },
      ],
    };
    expect(adapter.extractCharacterStats(a).identity.career).toBe('Hedge Apprentice');
  });

  it('falls back to details.career.value when there is no career item (source data)', () => {
    const a = {
      name: 'Greta',
      type: 'character',
      system: { details: { career: { value: 'Witch Hunter' } } },
      items: [],
    };
    expect(adapter.extractCharacterStats(a).identity.career).toBe('Witch Hunter');
  });

  it('never surfaces a sanitized circular reference as the career', () => {
    const a = {
      name: 'Anon',
      type: 'character',
      system: { details: { career: '[Circular Reference]' } },
      items: [],
    };
    expect(adapter.extractCharacterStats(a).identity?.career).toBeUndefined();
  });
});
