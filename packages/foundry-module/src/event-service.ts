import { MODULE_ID } from './constants.js';

/**
 * Push channel: game events the module reports to the MCP server so agents
 * can react (combat turns, chat messages, dice results) instead of polling.
 *
 * Events flow module -> socket-bridge ('bridge-event' message) -> server ring
 * buffer -> wait-for-event / get-recent-events tools.
 */

export interface BridgeEvent {
  type: 'combat-started' | 'combat-turn' | 'combat-ended' | 'chat-message' | 'roll-completed';
  timestamp: string;
  data: Record<string, unknown>;
}

type EventSender = (event: BridgeEvent) => void;

export class EventService {
  private sender: EventSender | null = null;
  private hookIds: Array<{ hook: string; id: number }> = [];

  setSender(sender: EventSender | null): void {
    this.sender = sender;
  }

  /** Register Foundry hooks once (GM client only). */
  registerHooks(): void {
    if (this.hookIds.length > 0) return;

    const combatStartId = Hooks.on('combatStart', (combat: any) => {
      if (!this.sender) return;
      this.emit('combat-started', {
        combatId: combat?.id,
        round: combat?.round,
        combatants: this.combatantSummaries(combat),
      });
    }) as unknown as number;
    this.hookIds.push({ hook: 'combatStart', id: combatStartId });

    const combatTurnChangeId = Hooks.on(
      'combatTurnChange',
      (combat: any, _prior: any, current: any) => {
        if (!this.sender) return;
        this.emit('combat-turn', {
          combatId: combat?.id,
          round: current?.round ?? combat?.round,
          turn: current?.turn ?? combat?.turn,
          combatant: this.combatantSummary(combat?.combatant),
        });
      }
    ) as unknown as number;
    this.hookIds.push({ hook: 'combatTurnChange', id: combatTurnChangeId });

    const deleteCombatId = Hooks.on('deleteCombat', (combat: any) => {
      if (!this.sender) return;
      this.emit('combat-ended', { combatId: combat?.id, round: combat?.round });
    }) as unknown as number;
    this.hookIds.push({ hook: 'deleteCombat', id: deleteCombatId });

    const createChatMessageId = Hooks.on('createChatMessage', (message: any) => {
      if (!this.sender) return;
      const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
      if (rolls.length) {
        this.emit('roll-completed', {
          messageId: message.id,
          speaker: message.speaker?.alias || message.speaker?.actor || null,
          user: message.author?.name ?? message.user?.name ?? null,
          flavor: message.flavor || '',
          rolls: rolls.map((roll: any) => ({
            formula: roll.formula,
            total: roll.total,
          })),
        });
      } else {
        this.emit('chat-message', {
          messageId: message.id,
          speaker: message.speaker?.alias || null,
          user: message.author?.name ?? message.user?.name ?? null,
          // keep payloads small: plain text, capped
          text: String(message.content || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 400),
        });
      }
    }) as unknown as number;
    this.hookIds.push({ hook: 'createChatMessage', id: createChatMessageId });
  }

  /** Remove every Foundry hook and stop delivering events. */
  unregisterHooks(): void {
    this.setSender(null);

    for (const { hook, id } of this.hookIds) {
      (Hooks as any).off(hook, id);
    }
    this.hookIds = [];
  }

  private emit(type: BridgeEvent['type'], data: Record<string, unknown>): void {
    if (!this.sender) return;
    try {
      const enabled = game.settings.get(MODULE_ID, 'enableEventPush');
      if (enabled === false) return;
    } catch {
      // setting not registered yet — default to enabled
    }
    try {
      this.sender({ type, timestamp: new Date().toISOString(), data });
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to push bridge event`, error);
    }
  }

  private combatantSummaries(combat: any): Array<Record<string, unknown>> {
    try {
      return (combat?.combatants?.contents || []).map((combatant: any) =>
        this.combatantSummary(combatant)
      );
    } catch {
      return [];
    }
  }

  private combatantSummary(combatant: any): Record<string, unknown> | null {
    if (!combatant) return null;
    return {
      id: combatant.id,
      name: combatant.name,
      actorId: combatant.actorId,
      tokenId: combatant.tokenId,
      initiative: combatant.initiative,
      defeated: combatant.isDefeated ?? combatant.defeated,
    };
  }
}

export const eventService = new EventService();
