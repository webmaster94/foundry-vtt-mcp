import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentSerializer } from './document-serializer.js';

class MockNode {
  constructor(public nodeName: string) {}
}

class MockElement extends MockNode {}

const LEGACY_SENSE_KEYS = ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const;

describe('DocumentSerializer D&D5e sense compatibility', () => {
  beforeEach(() => {
    vi.stubGlobal('Node', MockNode);
    vi.stubGlobal('Element', MockElement);
    vi.stubGlobal('game', {
      settings: { get: vi.fn().mockReturnValue(256_000) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves legacy sense aliases without invoking D&D5e 5.3 deprecation getters', () => {
    const ranges = {
      darkvision: 60,
      blindsight: 10,
      tremorsense: 20,
      truesight: 30,
    };
    const senses: Record<string, unknown> = { ranges, units: 'ft', special: '' };
    const getter = vi.fn<(key: (typeof LEGACY_SENSE_KEYS)[number]) => number>(key => ranges[key]);

    for (const key of LEGACY_SENSE_KEYS) {
      Object.defineProperty(senses, key, {
        enumerable: true,
        get: () => getter(key),
        set: value => {
          ranges[key] = Number(value);
        },
      });
    }

    const actor = {
      documentName: 'Actor',
      id: 'actor-1',
      uuid: 'Actor.actor-1',
      name: 'Test Actor',
      type: 'npc',
      system: { attributes: { senses } },
      toObject: () => ({ system: { attributes: { senses: { ranges } } } }),
    };

    const serializer = new DocumentSerializer();
    const full = serializer.serialize(actor);
    const projected = serializer.serialize(actor, {
      fields: ['system.attributes.senses.darkvision'],
    });

    expect(getter).not.toHaveBeenCalled();
    expect(full.data).toMatchObject({
      system: {
        attributes: {
          senses: {
            ranges,
            darkvision: 60,
            blindsight: 10,
            tremorsense: 20,
            truesight: 30,
          },
        },
      },
    });
    expect(projected.data).toEqual({
      system: { attributes: { senses: { darkvision: 60 } } },
    });
  });

  it('continues to serialize unrelated accessors normally', () => {
    const getter = vi.fn().mockReturnValue(120);
    const value = { ranges: { darkvision: 60 } } as Record<string, unknown>;
    Object.defineProperty(value, 'darkvision', {
      enumerable: true,
      get: getter,
    });

    const serialized = new DocumentSerializer().serialize(value);

    expect(getter).toHaveBeenCalledOnce();
    expect(serialized.data).toEqual({ ranges: { darkvision: 60 }, darkvision: 120 });
  });
});
