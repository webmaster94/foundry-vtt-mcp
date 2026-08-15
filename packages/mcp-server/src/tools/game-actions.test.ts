import { describe, expect, it, vi } from 'vitest';
import { GameActionTools } from './game-actions.js';
import { SystemRegistry } from '../systems/system-registry.js';
import { MGT2eAdapter } from '../systems/mgt2e/adapter.js';

describe('GameActionTools', () => {
  it('normalizes MGT2e multi-actor specs through the existing audited builder handler', async () => {
    const query = vi
      .fn()
      .mockImplementation(async method =>
        method === 'foundry-mcp-bridge.getWorldInfo' ? { system: 'mgt2e' } : { success: true }
      );
    const logger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const systemRegistry = new SystemRegistry();
    systemRegistry.register(new MGT2eAdapter());
    const tools = new GameActionTools({
      foundryClient: { query } as any,
      registry: {} as any,
      logger: logger as any,
      systemRegistry,
    });

    await tools.handleToolCall('build-actors-from-spec', {
      specs: [
        { name: 'Pilot', system: { skills: { Pilot: 2 } }, addToScene: true },
        { name: 'Medic', system: { skills: { medic: 1 } } },
      ],
    });

    expect(query).toHaveBeenLastCalledWith('foundry-mcp-bridge.buildActorsFromSpec', {
      specs: [
        expect.objectContaining({
          name: 'Pilot',
          addToScene: true,
          system: {
            skills: expect.objectContaining({
              pilot: expect.objectContaining({ value: 2, trained: true }),
            }),
          },
        }),
        expect.objectContaining({
          name: 'Medic',
          system: { skills: { medic: { id: 'medic', value: 1, trained: true } } },
        }),
      ],
    });
  });
});
