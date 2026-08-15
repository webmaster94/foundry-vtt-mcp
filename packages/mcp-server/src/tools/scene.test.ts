import { describe, expect, it, vi } from 'vitest';
import { SceneTools } from './scene.js';

function createTools() {
  const query = vi.fn().mockResolvedValue({ success: true });
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  const tools = new SceneTools({
    foundryClient: { query } as any,
    logger: logger as any,
  });

  return { tools, query };
}

describe('SceneTools scene navigation', () => {
  it('advertises list-scenes and switch-scene with a non-strict compatibility schema', () => {
    const { tools } = createTools();
    const definitions = tools.getToolDefinitions();
    const names = definitions.map(tool => tool.name);
    const switchScene = definitions.find(tool => tool.name === 'switch-scene');

    expect(names).toContain('list-scenes');
    expect(names).toContain('switch-scene');
    expect(switchScene?.inputSchema.additionalProperties).not.toBe(false);
    expect(switchScene?.inputSchema.properties).toHaveProperty('sceneId');
  });

  it('forwards scene list filters to the existing Foundry query', async () => {
    const { tools, query } = createTools();

    await tools.listScenes({ filter: 'tavern', include_active_only: true });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.list-scenes', {
      filter: 'tavern',
      include_active_only: true,
    });
  });

  it('accepts sceneId as a compatibility alias when switching scenes', async () => {
    const { tools, query } = createTools();

    await tools.switchScene({ sceneId: 'scene-123', optimize_view: false, dryRun: true });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.switch-scene', {
      scene_identifier: 'scene-123',
      optimize_view: false,
      dryRun: true,
    });
  });
});
