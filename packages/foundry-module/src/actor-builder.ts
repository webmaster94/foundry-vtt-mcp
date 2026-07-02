import { auditService } from './audit-service.js';
import { permissionManager } from './permissions.js';

/**
 * Build a complete actor from a declarative spec in one call: clone an
 * optional compendium template, override system data, resolve spells and
 * items from compendia by name, attach custom features, and file the result
 * into a folder. This collapses the dozens of round trips an agent would
 * otherwise need to assemble an NPC.
 */

export interface ActorSpecItem {
  /** Compendium item to pull, matched by exact name (case-insensitive). */
  name: string;
  /** Rename the pulled item (e.g. "Backpack" -> "Research Satchel"). */
  rename?: string;
  quantity?: number;
  /** Merged over the pulled item's system data (e.g. { equipped: true }). */
  system?: Record<string, unknown>;
  /** Replaces the pulled item's description. */
  description?: string;
}

export interface ActorSpecFeature {
  name: string;
  description: string;
  /** e.g. { type: 'reaction', value: 1 } */
  activation?: Record<string, unknown>;
}

export interface ActorSpec {
  name: string;
  type?: string;
  /** Folder name or id; resolved case-insensitively against existing Actor folders. */
  folder?: string;
  /** Optional compendium actor to clone as the base: { packId, entryId } or { name }. */
  template?: { packId?: string; entryId?: string; name?: string };
  img?: string;
  /** Merged over the actor's system data (abilities, attributes, details...). */
  system?: Record<string, unknown>;
  prototypeToken?: Record<string, unknown>;
  /** Spell names pulled from compendia. Replaces template spells not listed when replaceTemplateSpells is true. */
  spells?: string[];
  replaceTemplateSpells?: boolean;
  /** Drop weapons that came with the template (when replacing armament). */
  dropTemplateWeapons?: boolean;
  items?: ActorSpecItem[];
  /** Custom feat-type features created inline. */
  features?: ActorSpecFeature[];
  /** Biography/notes HTML written to the standard biography path when the system has one. */
  biography?: string;
}

interface ResolutionMiss {
  kind: 'spell' | 'item' | 'template' | 'folder';
  name: string;
  note: string;
}

export class ActorBuilder {
  async build(spec: ActorSpec): Promise<any> {
    const check = permissionManager.checkWritePermission('document.create');
    if (!check.allowed) throw new Error(check.reason || 'Actor creation denied');
    if (!spec?.name) throw new Error('Actor spec requires a name');

    const start = Date.now();
    const misses: ResolutionMiss[] = [];
    const notes: string[] = [];

    // 1. Base data: template clone or fresh shell
    let data: Record<string, unknown> = { name: spec.name, type: spec.type || 'npc' };
    if (spec.template) {
      const template = await this.resolveTemplate(spec.template, misses);
      if (template) {
        data = template.toObject();
        delete (data as any)._id;
        data.name = spec.name;
        notes.push(`Cloned template "${template.name}" from ${template.pack || 'compendium'}`);
      }
    }
    if (spec.type) data.type = spec.type;
    if (spec.img) data.img = spec.img;

    // 2. Folder
    if (spec.folder) {
      const folder = this.resolveFolder(spec.folder);
      if (folder) data.folder = folder.id;
      else
        misses.push({
          kind: 'folder',
          name: spec.folder,
          note: 'No Actor folder with this name or id; actor created at root',
        });
    }

    // 3. System overrides
    const utils = (globalThis as any).foundry.utils;
    if (spec.system) {
      data.system = utils.mergeObject(data.system || {}, spec.system, {
        overwrite: true,
        inplace: false,
      });
    }
    if (spec.biography) {
      utils.setProperty(data, 'system.details.biography.value', spec.biography);
    }

    // 4. Prototype token
    data.prototypeToken = utils.mergeObject(
      (data.prototypeToken as Record<string, unknown>) || {},
      { name: spec.name, ...(spec.prototypeToken || {}) },
      { overwrite: true, inplace: false }
    );

    // 5. Items: reconcile template items, pull compendium spells/items, add features
    let items: Array<Record<string, unknown>> = Array.isArray(data.items)
      ? (data.items as Array<Record<string, unknown>>)
      : [];

    if (spec.dropTemplateWeapons) {
      const before = items.length;
      items = items.filter(item => item.type !== 'weapon');
      if (before !== items.length)
        notes.push(`Dropped ${before - items.length} template weapon(s)`);
    }

    if (spec.spells) {
      const desired = new Set(spec.spells.map(name => this.normalize(name)));
      if (spec.replaceTemplateSpells !== false) {
        const before = items.length;
        items = items.filter(
          item => item.type !== 'spell' || desired.has(this.normalize(String(item.name)))
        );
        if (before !== items.length)
          notes.push(`Removed ${before - items.length} template spell(s) not in spec`);
      }
      const have = new Set(
        items.filter(item => item.type === 'spell').map(item => this.normalize(String(item.name)))
      );
      for (const spellName of spec.spells) {
        if (have.has(this.normalize(spellName))) continue;
        const spell = await this.pullFromPacks('Item', spellName, ['spell']);
        if (spell) items.push(spell);
        else
          misses.push({ kind: 'spell', name: spellName, note: 'Not found in any Item compendium' });
      }
      // dnd5e: mark leveled spells prepared so they are castable on NPC sheets
      if ((game as any).system?.id === 'dnd5e') {
        for (const item of items) {
          if (item.type === 'spell' && ((item.system as any)?.level ?? 0) > 0) {
            utils.setProperty(item, 'system.preparation', { mode: 'prepared', prepared: true });
          }
        }
      }
    }

    for (const itemSpec of spec.items || []) {
      const pulled = await this.pullFromPacks('Item', itemSpec.name);
      if (!pulled) {
        misses.push({
          kind: 'item',
          name: itemSpec.name,
          note: 'Not found in any Item compendium',
        });
        continue;
      }
      if (itemSpec.rename) pulled.name = itemSpec.rename;
      if (itemSpec.quantity) utils.setProperty(pulled, 'system.quantity', itemSpec.quantity);
      if (itemSpec.system) {
        pulled.system = utils.mergeObject(pulled.system || {}, itemSpec.system, {
          overwrite: true,
          inplace: false,
        });
      }
      if (itemSpec.description)
        utils.setProperty(pulled, 'system.description.value', itemSpec.description);
      items.push(pulled);
    }

    for (const feature of spec.features || []) {
      items.push({
        name: feature.name,
        type: 'feat',
        system: {
          description: { value: feature.description },
          ...(feature.activation ? { activation: feature.activation } : {}),
        },
      });
    }

    data.items = items;

    // 6. Create
    try {
      const actor = await (Actor as any).create(data);
      const result = {
        success: true,
        actor: { uuid: actor.uuid, id: actor.id, name: actor.name, type: actor.type },
        folder: actor.folder ? { id: actor.folder.id, name: actor.folder.name } : null,
        itemCount: this.count(actor.items),
        notes,
        unresolved: misses,
      };
      await auditService.record({
        operation: 'actor.build',
        toolName: 'build-actor-from-spec',
        documentRefs: [{ uuid: actor.uuid, id: actor.id, documentName: 'Actor', name: actor.name }],
        payloadSummary: {
          name: spec.name,
          type: data.type,
          spellCount: spec.spells?.length || 0,
          itemCount: (spec.items?.length || 0) + (spec.features?.length || 0),
        },
        resultSummary: { itemCount: result.itemCount, unresolved: misses.length },
        durationMs: Date.now() - start,
        success: true,
        inverse: { kind: 'delete', documentType: 'Actor', ref: { uuid: actor.uuid } },
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'actor.build',
        toolName: 'build-actor-from-spec',
        payloadSummary: { name: spec.name },
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private normalize(value: string): string {
    return value.toLowerCase().replace(/[’']/g, "'").trim();
  }

  private resolveFolder(nameOrId: string): any {
    const folders = (game as any).folders?.filter((f: any) => f.type === 'Actor') || [];
    return (
      folders.find((f: any) => f.id === nameOrId) ||
      folders.find((f: any) => this.normalize(f.name) === this.normalize(nameOrId)) ||
      null
    );
  }

  private async resolveTemplate(
    template: NonNullable<ActorSpec['template']>,
    misses: ResolutionMiss[]
  ): Promise<any> {
    if (template.packId && template.entryId) {
      const pack = (game as any).packs?.get(template.packId);
      const doc = pack ? await pack.getDocument(template.entryId) : null;
      if (doc) return doc;
      misses.push({
        kind: 'template',
        name: `${template.packId}/${template.entryId}`,
        note: 'Template not found; building actor from scratch',
      });
      return null;
    }
    if (template.name) {
      const doc = await this.pullDocumentFromPacks('Actor', template.name);
      if (doc) return doc;
      misses.push({
        kind: 'template',
        name: template.name,
        note: 'No compendium actor with this name; building actor from scratch',
      });
    }
    return null;
  }

  /** Find a compendium document by exact (case/apostrophe-insensitive) name; returns the document. */
  private async pullDocumentFromPacks(documentType: string, name: string): Promise<any> {
    const want = this.normalize(name);
    const packs = ((game as any).packs?.contents || []).filter(
      (pack: any) => pack.documentName === documentType
    );
    for (const pack of packs) {
      try {
        const index = await pack.getIndex();
        const entry = this.indexToArray(index).find(
          (candidate: any) => this.normalize(String(candidate.name || '')) === want
        );
        if (entry) {
          const doc = await pack.getDocument(entry._id);
          if (doc) return doc;
        }
      } catch {
        // unreadable pack; keep searching
      }
    }
    return null;
  }

  /** Same as pullDocumentFromPacks, but returns plain object data ready to embed. */
  private async pullFromPacks(
    documentType: string,
    name: string,
    preferredTypes?: string[]
  ): Promise<Record<string, unknown> | null> {
    const want = this.normalize(name);
    const packs = ((game as any).packs?.contents || []).filter(
      (pack: any) => pack.documentName === documentType
    );
    let fallback: Record<string, unknown> | null = null;
    for (const pack of packs) {
      try {
        const index = await pack.getIndex({ fields: ['type'] });
        const entry = this.indexToArray(index).find(
          (candidate: any) => this.normalize(String(candidate.name || '')) === want
        );
        if (!entry) continue;
        const doc = await pack.getDocument(entry._id);
        if (!doc) continue;
        const data = doc.toObject();
        delete (data as any)._id;
        if (!preferredTypes || preferredTypes.includes(String(data.type))) {
          return data;
        }
        fallback = fallback || data;
      } catch {
        // unreadable pack; keep searching
      }
    }
    return fallback;
  }

  private indexToArray(index: any): any[] {
    if (!index) return [];
    if (Array.isArray(index)) return index;
    if (typeof index.values === 'function') return Array.from(index.values());
    return Object.values(index);
  }

  private count(collection: any): number {
    if (typeof collection?.size === 'number') return collection.size;
    if (Array.isArray(collection?.contents)) return collection.contents.length;
    return 0;
  }
}

export const actorBuilder = new ActorBuilder();
