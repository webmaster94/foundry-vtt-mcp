import { describe, expect, it } from 'vitest';
import { MGT2eAdapter } from './adapter.js';
import { calcDM } from './constants.js';

const traveller = {
  name: 'Korvath Renn',
  type: 'traveller',
  system: {
    characteristics: {
      STR: { value: 7 },
      DEX: { value: 9 },
      END: { value: 6 },
      INT: { value: 11 },
      EDU: { value: 10 },
      SOC: { value: 8 },
    },
    damage: { STR: { value: 2 }, DEX: { value: 0 }, END: { value: 0 } },
    skills: {
      pilot: {
        value: 0,
        trained: true,
        specialities: {
          spacecraft: { value: 2, trained: true },
          smallCraft: { value: 1, trained: true },
          capitalShips: { value: 0, trained: false },
        },
      },
      mechanic: { value: 1, trained: true },
    },
    hits: { value: 22, max: 25 },
    sophont: {
      species: 'Human',
      gender: 'M',
      age: 34,
      homeworld: 'Regina/Spinward Marches',
      profession: 'Navy Captain',
    },
  },
};

describe('MGT2eAdapter', () => {
  const adapter = new MGT2eAdapter();

  it('advertises only character-oriented support', () => {
    const metadata = adapter.getMetadata();
    expect(metadata.id).toBe('mgt2e');
    expect(metadata.supportedFeatures).toEqual({
      characterStats: true,
      spellcasting: false,
      powerLevel: false,
    });
    expect('creatureIndex' in metadata.supportedFeatures).toBe(false);
    expect(adapter.canHandle('MGT2E')).toBe(true);
    expect(adapter.canHandle('pf2e')).toBe(false);
  });

  it('extracts characteristics, damage-aware DMs, skills, specialities, and hits', () => {
    const stats = adapter.extractCharacterStats(traveller);
    expect(stats.characteristics.STR).toEqual({
      value: 7,
      damage: 2,
      effective: 5,
      dm: -1,
      full: 'Strength',
    });
    expect(stats.characteristics.DEX.dm).toBe(1);
    expect(stats.skills.mechanic.level).toBe(1);
    expect(stats.skills.pilot.specialities).toEqual({ spacecraft: 2, smallCraft: 1 });
    expect(stats.hits).toEqual({ value: 22, max: 25 });
  });

  it('extracts traveller, creature, spacecraft, vehicle, and world basic info', () => {
    expect(adapter.extractBasicInfo(traveller)).toMatchObject({
      actorType: 'traveller',
      species: 'Human',
      homeworld: 'Regina/Spinward Marches',
      profession: 'Navy Captain',
    });
    expect(
      adapter.extractBasicInfo({
        type: 'creature',
        system: { behaviour: 'carnivore chaser', traits: 'Large, Flyer 3' },
      })
    ).toMatchObject({
      actorType: 'creature',
      behaviour: 'carnivore chaser',
      traits: 'Large, Flyer 3',
    });
    expect(
      adapter.extractBasicInfo({
        type: 'spacecraft',
        system: { spacecraft: { dtons: 200, configuration: 'streamlined', tl: 12, jdrive: 2 } },
      })
    ).toMatchObject({ actorType: 'spacecraft', dtons: 200, techLevel: 12, jDrive: 2 });
    expect(
      adapter.extractBasicInfo({
        type: 'vehicle',
        system: {
          vehicle: { chassis: 'lightGround', subtype: 'gravVehicle', skill: 'flyer.grav' },
        },
      })
    ).toMatchObject({ actorType: 'vehicle', chassis: 'lightGround', skill: 'flyer.grav' });
    expect(
      adapter.extractBasicInfo({
        type: 'world',
        system: { world: { uwp: { port: 'C', population: 3, techLevel: 8 } } },
      })
    ).toMatchObject({ actorType: 'world', uwp: { port: 'C', population: 3, techLevel: 8 } });
  });

  it('provides schema guidance and delegates payload normalization', () => {
    expect(adapter.describeActorSchema()).toContain('system.sophont');
    expect(adapter.describeActorSchema()).toContain('SOFTWARE ITEMS');
    expect(adapter.normalizePayload({ skills: { Pilot: 2, admin: 1 } })).toMatchObject({
      skills: {
        pilot: {
          value: 2,
          trained: true,
          specialities: { smallCraft: { value: 2, trained: true } },
        },
        admin: { id: 'admin', value: 1, trained: true },
      },
    });
  });
});

describe('calcDM', () => {
  it.each([
    [0, -3],
    [1, -2],
    [2, -2],
    [3, -1],
    [5, -1],
    [6, 0],
    [8, 0],
    [9, 1],
    [11, 1],
    [12, 2],
    [14, 2],
    [15, 3],
    [20, 3],
  ])('maps characteristic %i to DM %i', (value, expected) => {
    expect(calcDM(value)).toBe(expected);
  });
});
