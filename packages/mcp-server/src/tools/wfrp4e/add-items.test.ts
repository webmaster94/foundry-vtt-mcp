/**
 * WFRP4e add-items tool tests.
 *
 * The compendium resolution itself runs browser-side (in the Foundry module),
 * so these cover the MCP tool layer: schema validation and that valid calls are
 * forwarded to the `addWfrp4eItems` bridge query with the expected payload.
 */

import { describe, it, expect, vi } from 'vitest';
import { WFRP4eAddItemsTools } from './add-items.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = { info: vi.fn(), error: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new WFRP4eAddItemsTools({ foundryClient, logger });
  return { tools, query };
}

describe('WFRP4eAddItemsTools.getToolDefinitions', () => {
  it('exposes wfrp4e-add-items requiring actor and items', () => {
    const [def] = makeTools().tools.getToolDefinitions();
    expect(def.name).toBe('wfrp4e-add-items');
    expect(def.inputSchema.required).toEqual(['actor', 'items']);
    expect((def.inputSchema.properties as any).items.items.required).toEqual(['name']);
  });
});

describe('WFRP4eAddItemsTools.handleAddItems', () => {
  it('forwards a valid call to the addWfrp4eItems bridge query', async () => {
    const { tools, query } = makeTools();
    const args = {
      actor: 'Greta',
      items: [
        { name: 'Stealth (Rural)', advances: 10 },
        { name: 'Strike Mighty Blow', type: 'talent' },
        { name: 'Huntsman', type: 'career', setCurrent: true },
      ],
    };

    const result = await tools.handleAddItems(args);

    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.addWfrp4eItems', {
      actor: 'Greta',
      items: args.items,
    });
  });

  it('rejects a missing actor without calling the bridge', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleAddItems({ items: [{ name: 'Stealth' }] });
    expect(result.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty items array', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleAddItems({ actor: 'Greta', items: [] });
    expect(result.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unknown top-level and per-item keys (strict schema)', async () => {
    const { tools, query } = makeTools();
    const bothBad = [
      { actor: 'Greta', items: [{ name: 'Stealth' }], wounds: 5 },
      { actor: 'Greta', items: [{ name: 'Stealth', level: 3 }] },
    ];
    for (const args of bothBad) {
      const result = await tools.handleAddItems(args);
      expect(result.success).toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('surfaces bridge errors as a failed result', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('Actor not found: Greta');
    });
    const result = await tools.handleAddItems({
      actor: 'Greta',
      items: [{ name: 'Stealth' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Actor not found');
  });
});
