import { auditService } from './audit-service.js';
import { documentService } from './document-service.js';
import { permissionManager } from './permissions.js';

/**
 * Combat execution: initiative rolling and damage/healing application —
 * the operations that let an agent actually run an encounter instead of
 * hand-writing scripts. Damage and healing are audited and undoable.
 */

export interface TargetRef {
  uuid?: string;
  actorId?: string;
  actorName?: string;
  tokenId?: string;
}

export class CombatService {
  /** Roll initiative for all, NPCs only, or specific combatants. */
  async rollInitiative(request: {
    combatRef?: { uuid?: string; id?: string };
    mode?: 'all' | 'npc' | 'ids';
    combatantIds?: string[];
  }): Promise<any> {
    this.assertWrite('combat.initiative');
    const combat = await this.resolveCombat(request.combatRef);
    const mode = request.mode || 'all';

    if (mode === 'ids') {
      if (!request.combatantIds?.length) {
        throw new Error('mode "ids" requires combatantIds');
      }
      await combat.rollInitiative(request.combatantIds);
    } else if (mode === 'npc' && typeof combat.rollNPC === 'function') {
      await combat.rollNPC();
    } else if (typeof combat.rollAll === 'function') {
      await combat.rollAll();
    } else {
      await combat.rollInitiative(combat.combatants.contents.map((c: any) => c.id));
    }

    const order = combat.combatants.contents
      .map((c: any) => ({ id: c.id, name: c.name, initiative: c.initiative }))
      .sort((a: any, b: any) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity));

    await auditService.record({
      operation: 'combat.initiative',
      toolName: 'roll-initiative',
      documentRefs: [{ uuid: combat.uuid, id: combat.id, documentName: 'Combat' }],
      payloadSummary: { mode },
      resultSummary: { order },
      success: true,
    });

    return { success: true, combatId: combat.id, round: combat.round, order };
  }

  /** Apply damage: temp HP absorbs first (dnd5e convention), then HP, clamped at 0. */
  async applyDamage(request: {
    target: TargetRef;
    amount: number;
    groupId?: string;
  }): Promise<any> {
    return this.adjustHp(
      request.target,
      -Math.abs(request.amount),
      'combat.damage',
      'apply-damage',
      request.groupId
    );
  }

  /** Apply healing: raises HP, clamped at max. */
  async applyHealing(request: {
    target: TargetRef;
    amount: number;
    groupId?: string;
  }): Promise<any> {
    return this.adjustHp(
      request.target,
      Math.abs(request.amount),
      'combat.healing',
      'apply-healing',
      request.groupId
    );
  }

  private async adjustHp(
    target: TargetRef,
    delta: number,
    operation: string,
    toolName: string,
    groupId?: string
  ): Promise<any> {
    this.assertWrite(operation);
    const actor = await this.resolveActor(target);
    const hp = (actor.system as any)?.attributes?.hp;
    if (!hp || typeof hp.value !== 'number') {
      throw new Error(
        `Actor "${actor.name}" has no system.attributes.hp — apply damage via update-document for this system`
      );
    }

    const prior = { value: hp.value, temp: hp.temp ?? null };
    let value = hp.value;
    let temp = typeof hp.temp === 'number' ? hp.temp : 0;

    if (delta < 0) {
      let damage = -delta;
      const absorbed = Math.min(temp, damage);
      temp -= absorbed;
      damage -= absorbed;
      value = Math.max(0, value - damage);
    } else {
      const max = typeof hp.max === 'number' ? hp.max : value + delta;
      value = Math.min(max, value + delta);
    }

    const updates: Record<string, unknown> = {
      'system.attributes.hp.value': value,
      'system.attributes.hp.temp': temp > 0 ? temp : null,
    };
    await actor.update(updates);

    const result = {
      success: true,
      actor: { uuid: actor.uuid, id: actor.id, name: actor.name },
      applied: delta,
      hp: { value, temp: temp > 0 ? temp : null, max: hp.max },
      unconscious: value === 0,
    };

    await auditService.record({
      operation,
      toolName,
      documentRefs: [{ uuid: actor.uuid, id: actor.id, documentName: 'Actor', name: actor.name }],
      payloadSummary: { amount: delta },
      resultSummary: result.hp,
      success: true,
      ...(groupId ? { groupId } : {}),
      inverse: {
        kind: 'update',
        ref: { uuid: actor.uuid },
        updates: {
          'system.attributes.hp.value': prior.value,
          'system.attributes.hp.temp': prior.temp,
        },
      },
    });

    return result;
  }

  /**
   * Add an ActiveEffect (buff/debuff/condition) to an actor or token actor.
   * changes use Foundry's {key, mode, value} format; mode 2 = ADD, 5 = OVERRIDE.
   */
  async addActiveEffect(request: {
    target: TargetRef;
    name: string;
    img?: string;
    changes?: Array<{ key: string; mode?: number; value: string | number }>;
    duration?: { rounds?: number; seconds?: number; turns?: number };
    disabled?: boolean;
    description?: string;
    groupId?: string;
  }): Promise<any> {
    this.assertWrite('effect.create');
    const actor = await this.resolveActor(request.target);

    const data: Record<string, unknown> = {
      name: request.name,
      img: request.img || 'icons/svg/aura.svg',
      changes: (request.changes || []).map(change => ({
        key: change.key,
        mode: change.mode ?? 2,
        value: String(change.value),
        priority: null,
      })),
      disabled: request.disabled ?? false,
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.description ? { description: request.description } : {}),
    };

    const created = await actor.createEmbeddedDocuments('ActiveEffect', [data]);
    const effect = Array.isArray(created) ? created[0] : created;

    await auditService.record({
      operation: 'effect.create',
      toolName: 'add-active-effect',
      documentRefs: [
        { uuid: actor.uuid, id: actor.id, documentName: 'Actor', name: actor.name },
        { uuid: effect?.uuid, id: effect?.id, documentName: 'ActiveEffect', name: request.name },
      ],
      payloadSummary: { name: request.name, changes: request.changes?.length || 0 },
      success: true,
      ...(request.groupId ? { groupId: request.groupId } : {}),
      inverse: {
        kind: 'embedded-delete',
        parentUuid: actor.uuid,
        embeddedType: 'ActiveEffect',
        ref: { embeddedId: effect?.id },
      },
    });

    return {
      success: true,
      actor: { uuid: actor.uuid, name: actor.name },
      effect: { id: effect?.id, uuid: effect?.uuid, name: request.name },
    };
  }

  /** Recent dice results from chat (both requested and organic player rolls). */
  getRollResults(request: { limit?: number; sinceMessageId?: string } = {}): any {
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 50);
    const messages = (game as any).messages?.contents || [];

    let startIndex = 0;
    if (request.sinceMessageId) {
      const idx = messages.findIndex((m: any) => m.id === request.sinceMessageId);
      if (idx >= 0) startIndex = idx + 1;
    }

    const results = [];
    for (let i = messages.length - 1; i >= startIndex && results.length < limit; i--) {
      const message = messages[i];
      const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
      if (!rolls.length) continue;
      results.push({
        messageId: message.id,
        timestamp: message.timestamp,
        speaker: message.speaker?.alias || null,
        user: message.author?.name ?? null,
        flavor: message.flavor || '',
        rolls: rolls.map((roll: any) => ({ formula: roll.formula, total: roll.total })),
      });
    }

    return { count: results.length, results };
  }

  private assertWrite(operation: string): void {
    const check = permissionManager.checkWritePermission(operation);
    if (!check.allowed) throw new Error(check.reason || `${operation} denied`);
  }

  private async resolveCombat(ref?: { uuid?: string; id?: string }): Promise<any> {
    if (ref?.uuid || ref?.id) {
      return documentService.resolveDocument({ ...ref, documentType: 'Combat' });
    }
    const active = (game as any).combat;
    if (!active) throw new Error('No active combat and no combatRef provided');
    return active;
  }

  private async resolveActor(target: TargetRef): Promise<any> {
    if (target.uuid) {
      const doc = await documentService.resolveDocument({ uuid: target.uuid });
      return doc.documentName === 'Token' ? doc.actor : doc;
    }
    if (target.tokenId) {
      const token =
        (globalThis as any).canvas?.tokens?.get(target.tokenId) ||
        (game as any).scenes?.active?.tokens?.get(target.tokenId);
      const actor = token?.actor;
      if (!actor) throw new Error(`Token "${target.tokenId}" not found on the active scene`);
      return actor;
    }
    if (target.actorId) {
      return documentService.resolveDocument({ documentType: 'Actor', id: target.actorId });
    }
    if (target.actorName) {
      return documentService.resolveDocument({ documentType: 'Actor', name: target.actorName });
    }
    throw new Error('Target requires uuid, tokenId, actorId, or actorName');
  }
}

export const combatService = new CombatService();
