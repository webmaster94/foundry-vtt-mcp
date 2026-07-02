export type DocumentMutationPolicy = 'full' | 'read-only' | 'unsupported';
export type DocumentRisk = 'normal' | 'high';

export interface DocumentRegistryEntry {
  documentType: string;
  collectionPath?: string;
  mutationPolicy: DocumentMutationPolicy;
  risk: DocumentRisk;
  embeddedTypes: string[];
}

const PRIMARY_DOCUMENTS: DocumentRegistryEntry[] = [
  { documentType: 'Actor', collectionPath: 'game.actors', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['Item', 'ActiveEffect'] },
  { documentType: 'Cards', collectionPath: 'game.cards', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['Card'] },
  { documentType: 'ChatMessage', collectionPath: 'game.messages', mutationPolicy: 'full', risk: 'normal', embeddedTypes: [] },
  { documentType: 'Combat', collectionPath: 'game.combats', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['Combatant', 'CombatantGroup'] },
  { documentType: 'Folder', collectionPath: 'game.folders', mutationPolicy: 'full', risk: 'normal', embeddedTypes: [] },
  { documentType: 'Item', collectionPath: 'game.items', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['ActiveEffect'] },
  { documentType: 'JournalEntry', collectionPath: 'game.journal', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['JournalEntryPage', 'JournalEntryCategory'] },
  { documentType: 'Macro', collectionPath: 'game.macros', mutationPolicy: 'full', risk: 'normal', embeddedTypes: [] },
  { documentType: 'Playlist', collectionPath: 'game.playlists', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['PlaylistSound'] },
  { documentType: 'RollTable', collectionPath: 'game.tables', mutationPolicy: 'full', risk: 'normal', embeddedTypes: ['TableResult'] },
  {
    documentType: 'Scene',
    collectionPath: 'game.scenes',
    mutationPolicy: 'full',
    risk: 'normal',
    embeddedTypes: ['Token', 'Wall', 'Tile', 'Drawing', 'AmbientLight', 'AmbientSound', 'MeasuredTemplate', 'Note', 'Region', 'RegionBehavior'],
  },
  { documentType: 'User', collectionPath: 'game.users', mutationPolicy: 'read-only', risk: 'normal', embeddedTypes: [] },
  { documentType: 'Setting', collectionPath: 'game.settings.storage', mutationPolicy: 'read-only', risk: 'high', embeddedTypes: [] },
  { documentType: 'FogExploration', collectionPath: 'game.collections.FogExploration', mutationPolicy: 'read-only', risk: 'high', embeddedTypes: [] },
  { documentType: 'Adventure', collectionPath: 'game.collections.Adventure', mutationPolicy: 'read-only', risk: 'high', embeddedTypes: [] },
];

const EMBEDDED_PARENT_TYPES: Record<string, string[]> = {
  ActiveEffect: ['Actor', 'Item'],
  Item: ['Actor'],
  JournalEntryPage: ['JournalEntry'],
  JournalEntryCategory: ['JournalEntry'],
  TableResult: ['RollTable'],
  PlaylistSound: ['Playlist'],
  Card: ['Cards'],
  Combatant: ['Combat'],
  CombatantGroup: ['Combat'],
  Token: ['Scene'],
  Wall: ['Scene'],
  Tile: ['Scene'],
  Drawing: ['Scene'],
  AmbientLight: ['Scene'],
  AmbientSound: ['Scene'],
  MeasuredTemplate: ['Scene'],
  Note: ['Scene'],
  Region: ['Scene'],
  RegionBehavior: ['Scene'],
};

export class DocumentRegistry {
  private entries = new Map<string, DocumentRegistryEntry>();

  constructor() {
    for (const entry of PRIMARY_DOCUMENTS) {
      this.entries.set(entry.documentType, entry);
    }
  }

  listDocumentTypes(): DocumentRegistryEntry[] {
    return Array.from(this.entries.values()).map((entry) => ({ ...entry, embeddedTypes: [...entry.embeddedTypes] }));
  }

  getEntry(documentType: string): DocumentRegistryEntry {
    const normalized = this.normalizeDocumentType(documentType);
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new Error(`Unsupported document type "${documentType}". Supported types: ${this.supportedTypes().join(', ')}`);
    }
    return entry;
  }

  getCollection(documentType: string): any {
    const entry = this.getEntry(documentType);

    switch (entry.documentType) {
      case 'Setting':
        return this.flattenSettingsStorage();
      case 'FogExploration':
      case 'Adventure':
        return this.getCollectionFromGameCollections(entry.documentType);
      default:
        return this.getByPath(entry.collectionPath || '');
    }
  }

  getDocumentClass(documentType: string): any {
    const normalized = this.normalizeDocumentType(documentType);
    const configured = (globalThis as any).CONFIG?.[normalized]?.documentClass;
    if (configured) {
      return configured;
    }
    return (globalThis as any)[normalized] || (globalThis as any).foundry?.documents?.[normalized];
  }

  getEmbeddedParentTypes(embeddedType: string): string[] {
    return EMBEDDED_PARENT_TYPES[embeddedType] || [];
  }

  normalizeDocumentType(documentType: string): string {
    const exact = this.entries.get(documentType);
    if (exact) return exact.documentType;

    const lowered = documentType.toLowerCase();
    const found = Array.from(this.entries.values()).find((entry) => entry.documentType.toLowerCase() === lowered);
    if (found) return found.documentType;

    if (lowered === 'tokendocument') return 'Token';
    return documentType;
  }

  supportedTypes(): string[] {
    return Array.from(this.entries.keys()).sort();
  }

  private getByPath(path: string): any {
    const parts = path.split('.').filter(Boolean);
    let value: any = globalThis;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }

  private getCollectionFromGameCollections(documentType: string): any {
    const collections = (globalThis as any).game?.collections;
    if (!collections) return undefined;
    if (typeof collections.get === 'function') return collections.get(documentType);
    return collections[documentType];
  }

  private flattenSettingsStorage(): any[] {
    const storage = (globalThis as any).game?.settings?.storage;
    if (!storage) return [];

    const rows: any[] = [];
    const storageCollections = this.collectionToArray(storage);
    for (const collection of storageCollections) {
      const settings = this.collectionToArray(collection);
      for (const setting of settings) {
        rows.push(setting);
      }
    }
    return rows;
  }

  private collectionToArray(collection: any): any[] {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (typeof collection.contents !== 'undefined' && Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === 'function') return Array.from(collection.values());
    if (typeof collection[Symbol.iterator] === 'function') return Array.from(collection);
    return Object.values(collection);
  }
}

export const documentRegistry = new DocumentRegistry();
