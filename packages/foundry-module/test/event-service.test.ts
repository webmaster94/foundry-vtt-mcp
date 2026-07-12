import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventService, type BridgeEvent } from '../src/event-service.js';

type HookCallback = (...args: any[]) => void;

describe('EventService hook lifecycle', () => {
  let callbacks: Map<string, HookCallback>;
  let nextHookId: number;
  let on: ReturnType<typeof vi.fn>;
  let off: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callbacks = new Map();
    nextHookId = 1;
    on = vi.fn((hook: string, callback: HookCallback) => {
      callbacks.set(hook, callback);
      return nextHookId++;
    });
    off = vi.fn();

    vi.stubGlobal('Hooks', { on, off });
    vi.stubGlobal('game', {
      settings: {
        get: vi.fn(() => true),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers each hook once and keeps pushing events while active', () => {
    const service = new EventService();
    const sent: BridgeEvent[] = [];
    service.setSender(event => sent.push(event));

    service.registerHooks();
    service.registerHooks();

    expect(on).toHaveBeenCalledTimes(4);

    callbacks.get('combatStart')?.({
      id: 'combat-1',
      round: 1,
      combatants: { contents: [] },
    });
    callbacks.get('createChatMessage')?.({
      id: 'message-1',
      content: '<p>Ready</p>',
      speaker: { alias: 'GM' },
      author: { name: 'Gamemaster' },
      rolls: [],
    });

    expect(sent.map(event => event.type)).toEqual(['combat-started', 'chat-message']);
  });

  it('unregisters retained hook ids, clears the sender, and is idempotent', () => {
    const service = new EventService();
    const sender = vi.fn();
    service.setSender(sender);
    service.registerHooks();

    const staleCombatCallback = callbacks.get('combatStart');
    service.unregisterHooks();
    service.unregisterHooks();

    expect(off.mock.calls).toEqual([
      ['combatStart', 1],
      ['combatTurnChange', 2],
      ['deleteCombat', 3],
      ['createChatMessage', 4],
    ]);

    staleCombatCallback?.({ id: 'combat-after-stop', combatants: { contents: [] } });
    expect(sender).not.toHaveBeenCalled();
  });

  it('can register a fresh set of hooks after being stopped', () => {
    const service = new EventService();

    service.registerHooks();
    service.unregisterHooks();
    service.registerHooks();

    expect(on).toHaveBeenCalledTimes(8);
    expect(on.mock.calls.slice(4).map(call => call[0])).toEqual([
      'combatStart',
      'combatTurnChange',
      'deleteCombat',
      'createChatMessage',
    ]);
  });
});
