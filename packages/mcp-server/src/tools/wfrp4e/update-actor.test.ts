/**
 * WFRP4e update-actor tool tests — focused on the schema/forwarding for the
 * newer skills/career fields alongside the existing characteristics/wounds.
 */

import { describe, it, expect, vi } from 'vitest';
import { WFRP4eUpdateActorTools } from './update-actor.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = { info: vi.fn(), error: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new WFRP4eUpdateActorTools({ foundryClient, logger });
  return { tools, query };
}

describe('WFRP4eUpdateActorTools.getToolDefinitions', () => {
  it('advertises skills and career inputs', () => {
    const [def] = makeTools().tools.getToolDefinitions();
    const props = def.inputSchema.properties as any;
    expect(def.name).toBe('wfrp4e-update-actor');
    expect(props.skills.type).toBe('array');
    expect(props.career.type).toBe('string');
  });
});

describe('WFRP4eUpdateActorTools.handleUpdateActor', () => {
  it('forwards skills, career, movement and biography to the bridge', async () => {
    const { tools, query } = makeTools();
    const args = {
      actor: 'Tylo',
      skills: [{ name: 'Channelling (Hedgecraft)', advances: 5 }],
      career: 'Hedge Master',
      movement: 5,
      biography: 'A hedge wizard of the Reikwald.',
    };

    const result = await tools.handleUpdateActor(args);

    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.updateWfrp4eActor', {
      actor: 'Tylo',
      characteristics: undefined,
      wounds: undefined,
      skills: args.skills,
      career: 'Hedge Master',
      movement: 5,
      biography: 'A hedge wizard of the Reikwald.',
    });
  });

  it('accepts a biography-only update', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleUpdateActor({ actor: 'Tylo', biography: 'Notes.' });
    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalled();
  });

  it('accepts career-only updates (not "nothing to update")', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleUpdateActor({
      actor: 'Tylo',
      career: 'Hedge Master',
    });
    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalled();
  });

  it('rejects an empty update with nothing to change', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleUpdateActor({ actor: 'Tylo' });
    expect(result.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a malformed skills entry (strict)', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleUpdateActor({
      actor: 'Tylo',
      skills: [{ name: 'Melee', bonus: 5 }],
    });
    expect(result.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
