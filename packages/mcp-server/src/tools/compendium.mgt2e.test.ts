import { describe, expect, it, vi } from 'vitest';
import { CompendiumTools } from './compendium.js';

function createTools(query: ReturnType<typeof vi.fn>) {
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  return new CompendiumTools({ foundryClient: { query } as any, logger: logger as any });
}

describe('CompendiumTools mgt2e summaries', () => {
  it('adds compact traveller and spacecraft stats to generic search results', async () => {
    const query = vi.fn(async (handler: string) => {
      if (handler === 'foundry-mcp-bridge.getWorldInfo') return { system: { id: 'mgt2e' } };
      if (handler === 'foundry-mcp-bridge.searchCompendium') {
        return [
          {
            id: 'traveller-1',
            name: 'Korvath Renn',
            type: 'traveller',
            pack: 'mgt2e.npcs',
            packLabel: 'NPCs',
            system: {
              sophont: { species: 'Human', profession: 'Navy', homeworld: 'Regina' },
              hits: { value: 22, max: 25 },
            },
          },
          {
            id: 'ship-1',
            name: 'Autumn Gold',
            type: 'spacecraft',
            pack: 'mgt2e.spacecraft',
            packLabel: 'Spacecraft',
            system: {
              spacecraft: {
                dtons: 200,
                configuration: 'streamlined',
                tl: 12,
                mdrive: 1,
                jdrive: 2,
                armour: 4,
              },
              hits: { value: 150, max: 160 },
            },
          },
        ];
      }
      throw new Error(`Unexpected query: ${handler}`);
    });
    const tools = createTools(query);

    const result = await tools.handleSearchCompendium({ query: 'gold' });

    expect(result.gameSystem).toBe('mgt2e');
    expect(result.results[0].stats).toEqual({
      hits: { current: 22, max: 25 },
      species: 'Human',
      profession: 'Navy',
      homeworld: 'Regina',
    });
    expect(result.results[1].stats).toMatchObject({
      hits: { current: 150, max: 160 },
      dtons: 200,
      configuration: 'streamlined',
      techLevel: 12,
      mDrive: 1,
      jDrive: 2,
      armour: 4,
    });
  });

  it('returns bounded mgt2e creature stats in compact item mode', async () => {
    const query = vi.fn().mockResolvedValue({
      id: 'creature-1',
      name: 'Cave Bear',
      type: 'creature',
      pack: 'mgt2e.creatures',
      packLabel: 'Creatures',
      system: {
        behaviour: 'carnivore chaser',
        traits: 'Large, Natural Weapons',
        hits: { value: 30, max: 30 },
        description: 'Massive cave predator.',
      },
      items: new Array(10).fill(null).map((_, index) => ({ id: String(index) })),
    });
    const tools = createTools(query);

    const result = await tools.handleGetCompendiumItem({
      packId: 'mgt2e.creatures',
      itemId: 'creature-1',
      compact: true,
    });

    expect(result.stats).toEqual({
      hits: { current: 30, max: 30 },
      behaviour: 'carnivore chaser',
      traits: 'Large, Natural Weapons',
    });
    expect(result.items).toHaveLength(5);
    expect(result.system).toBeUndefined();
  });
});
