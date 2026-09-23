import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess } from './data-access.js';
import { permissionManager } from './permissions.js';
import { auditService } from './audit-service.js';

const actor = (id: string, hp: number) => ({
  id,
  uuid: `Actor.${id}`,
  name: 'Shared name',
  type: 'character',
  system: { attributes: { hp: { value: hp } } },
  items: [],
  effects: [],
});
const collection = (values: any[]) => ({
  contents: values,
  get: (id: string) => values.find(x => x.id === id),
  find: (fn: (value: any) => boolean) => values.find(fn),
  values: () => values.values(),
});

beforeEach(() => {
  vi.stubGlobal('Node', class {});
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'test' },
    user: { isGM: true },
    system: { id: 'dnd5e' },
    actors: collection([]),
    scenes: collection([]),
    packs: new Map(),
    journal: new Map(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compatibility read serialization', () => {
  it('serializes detailed item Advancement from source without touching the live getter', async () => {
    const getter = vi.fn(() => {
      throw new Error('live advancement');
    });
    const system = { level: 7 };
    Object.defineProperty(system, 'advancement', { enumerable: true, get: getter });
    const item = {
      id: 'item',
      name: 'Class',
      system,
      toObject: () => ({ system: { advancement: [{ type: 'ScaleValue' }] } }),
    };
    (game as any).actors = collection([{ ...actor('base', 20), items: collection([item]) }]);
    const result = await new FoundryDataAccess().getCharacterEntity({
      characterIdentifier: 'base',
      entityIdentifier: 'item',
    });
    expect(result.entity.system).toEqual({ level: 7, advancement: [{ type: 'ScaleValue' }] });
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves activity save data while never reading the deprecated ability getter', async () => {
    const deprecated = vi.fn(() => {
      throw new Error('deprecated getter touched');
    });
    const strength = { value: 18 };
    Object.defineProperty(strength, 'save', { enumerable: true, get: deprecated });
    const save = { ability: ['dex'], dc: { calculation: 'spellcasting' } };
    const document = {
      id: 'item',
      name: 'Spell',
      type: 'spell',
      system: { abilities: { str: strength }, activities: { activity: { save } } },
      toObject: () => ({ system: { activities: { activity: { save } } } }),
    };
    (game as any).packs.set('test.pack', {
      metadata: { label: 'Test' },
      getDocument: async () => document,
    });
    const result = await new FoundryDataAccess().getCompendiumDocumentFull('test.pack', 'item');
    expect(result.system.activities).toEqual({ activity: { save } });
    expect((result.fullData as any).system.activities.activity.save).toEqual(save);
    expect(deprecated).not.toHaveBeenCalled();
  });
  it('uses only serialized Advancement source while retaining prepared system values', async () => {
    const liveGetter = vi.fn(() => {
      throw new Error('live advancement traversal');
    });
    const system = { level: 7 };
    Object.defineProperty(system, 'advancement', { enumerable: true, get: liveGetter });
    const advancement = [
      {
        _id: 'level',
        type: 'ScaleValue',
        configuration: { scale: { 1: { value: 3 } }, secret: 'hidden' },
      },
    ];
    const document = {
      id: 'item',
      name: 'Class',
      type: 'class',
      system,
      toObject: () => ({ system: { level: 1, advancement } }),
    };
    (game as any).packs.set('test.pack', {
      metadata: { label: 'Test' },
      getDocument: async () => document,
    });
    const result = await new FoundryDataAccess().getCompendiumDocumentFull('test.pack', 'item');
    expect(result.system.level).toBe(7);
    expect(result.system.advancement).toMatchObject([{ type: 'ScaleValue' }]);
    expect((result.fullData as any).system.advancement).toEqual(result.system.advancement);
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(liveGetter).not.toHaveBeenCalled();
  });
});

describe('exact character identity', () => {
  it('preserves world actor name precedence over bare token IDs', async () => {
    const base = { ...actor('base', 20), name: 'token1' };
    (game as any).actors = collection([base]);
    (game as any).scenes = collection([
      { id: 'scene1', tokens: collection([{ id: 'token1', actor: actor('other', 4) }]) },
    ]);
    expect((await new FoundryDataAccess().getCharacterInfo('token1')).id).toBe('base');
  });
  it('reads prepared synthetic token state without changing world actor ID semantics', async () => {
    const base = actor('base000000000001', 20);
    const synthetic = actor(base.id, 4);
    synthetic.uuid = 'Scene.scene1.Token.token00000000001.Actor.base000000000001';
    (game as any).actors = collection([base]);
    const token = {
      id: 'token00000000001',
      uuid: 'Scene.scene1.Token.token00000000001',
      actor: synthetic,
    };
    (game as any).scenes = collection([{ id: 'scene1', tokens: collection([token]) }]);
    const api = new FoundryDataAccess();
    expect((await api.getCharacterInfo(token.uuid)).system).toMatchObject({
      attributes: { hp: { value: 4 } },
    });
    expect(await api.getCharacterInfo(token.id)).toMatchObject({ tokenUuid: token.uuid });
    expect((await api.getCharacterInfo(base.id)).system).toMatchObject({
      attributes: { hp: { value: 20 } },
    });
    expect((await api.getCharacterInfo(base.uuid)).system).toMatchObject({
      attributes: { hp: { value: 20 } },
    });
  });
  it('rejects ambiguous token IDs and missing explicit UUIDs without falling back to names', async () => {
    const base = actor('base000000000001', 20);
    base.name = 'Scene.missing.Token.missing';
    (game as any).actors = collection([base]);
    (game as any).scenes = collection(
      ['one', 'two'].map(id => ({
        id,
        tokens: collection([
          { id: 'sharedtoken00001', uuid: `Scene.${id}.Token.sharedtoken00001`, actor: base },
        ]),
      }))
    );
    await expect(new FoundryDataAccess().getCharacterInfo('sharedtoken00001')).rejects.toThrow(
      /ambiguous/i
    );
    await expect(new FoundryDataAccess().getCharacterInfo(base.name)).rejects.toThrow(/not found/i);
  });
});

describe('journal page identity', () => {
  it('renames and edits one existing page, records the inverse, and creates no page', async () => {
    vi.spyOn(permissionManager, 'checkWritePermission').mockReturnValue({ allowed: true });
    const record = vi.spyOn(auditService, 'record').mockResolvedValue(undefined);
    const page = {
      id: 'page1',
      uuid: 'JournalEntry.journal1.JournalEntryPage.page1',
      documentName: 'JournalEntryPage',
      name: 'Old',
      type: 'text',
      text: { content: '<p>Old</p>' },
      update: vi.fn(),
      toObject() {
        return { _id: this.id, name: this.name, type: this.type, text: this.text };
      },
    };
    const pages = collection([page]);
    const journal = {
      id: 'journal1',
      uuid: 'JournalEntry.journal1',
      documentName: 'JournalEntry',
      pages,
      createEmbeddedDocuments: vi.fn(async () => [{ id: 'wrong-new-page' }]),
      getEmbeddedCollection: () => pages,
      updateEmbeddedDocuments: vi.fn(async (_type: string, [updates]: any[]) => {
        page.name = updates.name ?? page.name;
        page.text.content = updates['text.content'];
        return [page];
      }),
    };
    (game as any).journal.set(journal.id, journal);
    vi.stubGlobal('fromUuid', async () => journal);
    const result = await new FoundryDataAccess().updateJournalContent({
      journalId: journal.id,
      pageId: page.id,
      newPageName: 'New',
      content: '<p>New</p>',
    });
    expect(result).toMatchObject({ pageId: 'page1', pageName: 'New' });
    expect(journal.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        inverse: expect.objectContaining({
          kind: 'embedded-update',
          updates: { name: 'Old', 'text.content': '<p>Old</p>' },
        }),
      })
    );
  });
});
