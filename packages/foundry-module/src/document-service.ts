import { auditService } from './audit-service.js';
import { documentRegistry, type DocumentRegistryEntry } from './document-registry.js';
import { documentSerializer, type DocumentSerializationOptions } from './document-serializer.js';
import { permissionManager } from './permissions.js';

export interface DocumentRef {
  uuid?: string;
  documentType?: string;
  id?: string;
  name?: string;
  packId?: string;
}

export interface EmbeddedDocumentRef {
  parentUuid: string;
  embeddedType: string;
  embeddedId?: string;
  embeddedName?: string;
}

export interface ListDocumentsRequest extends DocumentSerializationOptions {
  documentType: string;
  packId?: string;
  search?: string;
  limit?: number;
}

export class DocumentService {
  listDocumentTypes(): DocumentRegistryEntry[] {
    return documentRegistry.listDocumentTypes();
  }

  async listDocuments(request: ListDocumentsRequest): Promise<any> {
    const docs = request.packId
      ? await this.listPackDocuments(request.packId, request.documentType)
      : this.collectionToArray(documentRegistry.getCollection(request.documentType));

    const search = request.search?.toLowerCase();
    const filtered = search
      ? docs.filter((doc) => String(doc?.name || doc?.id || '').toLowerCase().includes(search))
      : docs;
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);

    return {
      documentType: request.documentType,
      count: filtered.length,
      documents: filtered.slice(0, limit).map((doc) => this.serialize(doc, request)),
    };
  }

  async getDocument(request: { ref: DocumentRef } & DocumentSerializationOptions): Promise<any> {
    const doc = await this.resolveDocument(request.ref);
    return this.serialize(doc, request);
  }

  async createDocument(request: { documentType: string; data: Record<string, unknown>; confirmBulkOperation?: boolean } & DocumentSerializationOptions): Promise<any> {
    this.assertMutationAllowed(request.documentType, 'document.create');

    const documentClass = documentRegistry.getDocumentClass(request.documentType);
    if (!documentClass) {
      throw new Error(`Cannot find Foundry document class for ${request.documentType}`);
    }

    const start = Date.now();
    try {
      const created = await this.createWithClass(documentClass, request.data);
      const result = this.serialize(created, request);
      await auditService.record({
        operation: 'document.create',
        toolName: 'create-document',
        documentRefs: [this.documentRef(created)],
        payloadSummary: { documentType: request.documentType, data: request.data },
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'document.create',
        toolName: 'create-document',
        payloadSummary: { documentType: request.documentType, data: request.data },
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async updateDocument(request: { ref: DocumentRef; updates: Record<string, unknown> } & DocumentSerializationOptions): Promise<any> {
    const doc = await this.resolveDocument(request.ref);
    this.assertMutationAllowed(doc.documentName || request.ref.documentType || 'Document', 'document.update');
    const start = Date.now();

    try {
      const updated = await doc.update(request.updates);
      const result = this.serialize(updated || doc, request);
      await auditService.record({
        operation: 'document.update',
        toolName: 'update-document',
        documentRefs: [this.documentRef(doc)],
        payloadSummary: request.updates,
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'document.update',
        toolName: 'update-document',
        documentRefs: [this.documentRef(doc)],
        payloadSummary: request.updates,
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async deleteDocument(request: { ref: DocumentRef; confirmDeletion?: boolean }): Promise<any> {
    if (!request.confirmDeletion) {
      throw new Error('Deletion requires confirmDeletion=true');
    }

    const doc = await this.resolveDocument(request.ref);
    this.assertMutationAllowed(doc.documentName || request.ref.documentType || 'Document', 'document.delete');
    const ref = this.documentRef(doc);
    const start = Date.now();

    try {
      await doc.delete();
      const result = { success: true, deleted: ref };
      await auditService.record({
        operation: 'document.delete',
        toolName: 'delete-document',
        documentRefs: [ref],
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'document.delete',
        toolName: 'delete-document',
        documentRefs: [ref],
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async listEmbeddedDocuments(request: { parentUuid: string; embeddedType: string; search?: string; limit?: number } & DocumentSerializationOptions): Promise<any> {
    const parent = await this.resolveDocument({ uuid: request.parentUuid });
    const collection = this.getEmbeddedCollection(parent, request.embeddedType);
    const docs = this.collectionToArray(collection);
    const search = request.search?.toLowerCase();
    const filtered = search
      ? docs.filter((doc) => String(doc?.name || doc?.id || '').toLowerCase().includes(search))
      : docs;
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);

    return {
      parent: this.documentRef(parent),
      embeddedType: request.embeddedType,
      count: filtered.length,
      documents: filtered.slice(0, limit).map((doc) => this.serialize(doc, request)),
    };
  }

  async getEmbeddedDocument(request: { ref: EmbeddedDocumentRef } & DocumentSerializationOptions): Promise<any> {
    const doc = await this.resolveEmbeddedDocument(request.ref);
    return this.serialize(doc, request);
  }

  async createEmbeddedDocument(request: { parentUuid: string; embeddedType: string; data: Record<string, unknown>; confirmBulkOperation?: boolean } & DocumentSerializationOptions): Promise<any> {
    const parent = await this.resolveDocument({ uuid: request.parentUuid });
    this.assertEmbeddedMutationAllowed(parent, request.embeddedType);
    const start = Date.now();

    try {
      const created = await parent.createEmbeddedDocuments(request.embeddedType, [request.data]);
      const doc = Array.isArray(created) ? created[0] : created;
      const result = this.serialize(doc, request);
      await auditService.record({
        operation: 'embedded.create',
        toolName: 'create-embedded-document',
        documentRefs: [this.documentRef(parent), this.documentRef(doc)],
        payloadSummary: { embeddedType: request.embeddedType, data: request.data },
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'embedded.create',
        toolName: 'create-embedded-document',
        documentRefs: [this.documentRef(parent)],
        payloadSummary: { embeddedType: request.embeddedType, data: request.data },
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async updateEmbeddedDocument(request: { ref: EmbeddedDocumentRef; updates: Record<string, unknown> } & DocumentSerializationOptions): Promise<any> {
    const parent = await this.resolveDocument({ uuid: request.ref.parentUuid });
    this.assertEmbeddedMutationAllowed(parent, request.ref.embeddedType);
    const doc = await this.resolveEmbeddedDocument(request.ref);
    const start = Date.now();

    try {
      const updated = await parent.updateEmbeddedDocuments(request.ref.embeddedType, [{ _id: doc.id, ...request.updates }]);
      const resultDoc = Array.isArray(updated) ? updated[0] : doc;
      const result = this.serialize(resultDoc, request);
      await auditService.record({
        operation: 'embedded.update',
        toolName: 'update-embedded-document',
        documentRefs: [this.documentRef(parent), this.documentRef(doc)],
        payloadSummary: request.updates,
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'embedded.update',
        toolName: 'update-embedded-document',
        documentRefs: [this.documentRef(parent), this.documentRef(doc)],
        payloadSummary: request.updates,
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async deleteEmbeddedDocument(request: { ref: EmbeddedDocumentRef; confirmDeletion?: boolean }): Promise<any> {
    if (!request.confirmDeletion) {
      throw new Error('Deletion requires confirmDeletion=true');
    }

    const parent = await this.resolveDocument({ uuid: request.ref.parentUuid });
    this.assertEmbeddedMutationAllowed(parent, request.ref.embeddedType);
    const doc = await this.resolveEmbeddedDocument(request.ref);
    const ref = this.documentRef(doc);
    const start = Date.now();

    try {
      await parent.deleteEmbeddedDocuments(request.ref.embeddedType, [doc.id]);
      const result = { success: true, deleted: ref };
      await auditService.record({
        operation: 'embedded.delete',
        toolName: 'delete-embedded-document',
        documentRefs: [this.documentRef(parent), ref],
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'embedded.delete',
        toolName: 'delete-embedded-document',
        documentRefs: [this.documentRef(parent), ref],
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getDocumentSchema(documentType: string): Promise<any> {
    const entry = documentRegistry.getEntry(documentType);
    const documentClass = documentRegistry.getDocumentClass(documentType);
    const schema = documentClass?.schema || documentClass?.metadata || {};
    return {
      ...entry,
      className: documentClass?.name || null,
      schema: this.serialize(schema, { includeSystem: true }),
    };
  }

  async executeMacro(request: { uuid?: string; id?: string; name?: string; actorUuid?: string; tokenId?: string; speaker?: Record<string, unknown> }): Promise<any> {
    const check = permissionManager.checkWritePermission('macro.execute');
    if (!check.allowed) throw new Error(check.reason || 'Macro execution denied');

    const macroRef: DocumentRef = { documentType: 'Macro' };
    if (request.uuid) macroRef.uuid = request.uuid;
    if (request.id) macroRef.id = request.id;
    if (request.name) macroRef.name = request.name;
    const macro = await this.resolveDocument(macroRef);
    const start = Date.now();

    try {
      const scope: Record<string, unknown> = {};
      if (request.actorUuid) scope.actor = await this.resolveDocument({ uuid: request.actorUuid });
      if (request.tokenId && (globalThis as any).canvas?.tokens) scope.token = (globalThis as any).canvas.tokens.get(request.tokenId);
      if (request.speaker) scope.speaker = request.speaker;
      const result = await macro.execute(scope);
      const serialized = this.serialize(result, {});
      await auditService.record({
        operation: 'macro.execute',
        toolName: 'execute-macro',
        documentRefs: [this.documentRef(macro)],
        payloadSummary: request,
        resultSummary: serialized,
        durationMs: Date.now() - start,
        success: true,
      });
      return {
        success: true,
        macro: this.documentRef(macro),
        result: serialized,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      await auditService.record({
        operation: 'macro.execute',
        toolName: 'execute-macro',
        documentRefs: [this.documentRef(macro)],
        payloadSummary: request,
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async queryFoundryData(request: {
    root: string;
    filters?: Record<string, unknown>;
    fields?: string[];
    sort?: { field: string; direction?: 'asc' | 'desc' };
    limit?: number;
  } & DocumentSerializationOptions): Promise<any> {
    const collection = this.resolveAllowedRoot(request.root);
    let rows = this.collectionToArray(collection);
    rows = this.applyFilters(rows, request.filters || {});

    if (request.sort) {
      rows = this.sortRows(rows, request.sort.field, request.sort.direction || 'asc');
    }

    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);
    const serializationOptions: DocumentSerializationOptions = { ...request };
    if (request.fields) serializationOptions.fields = request.fields;
    return {
      root: request.root,
      count: rows.length,
      rows: rows.slice(0, limit).map((row) => this.serialize(row, serializationOptions)),
    };
  }

  async rollRollTable(ref: DocumentRef): Promise<any> {
    const table = await this.resolveDocument({ ...ref, documentType: 'RollTable' });
    if (typeof table.draw === 'function') return this.serialize(await table.draw(), {});
    if (typeof table.roll === 'function') return this.serialize(await table.roll(), {});
    throw new Error('RollTable does not support draw() or roll() in this Foundry version');
  }

  async playlistSoundAction(ref: DocumentRef, soundId: string, action: 'play' | 'stop'): Promise<any> {
    const playlist = await this.resolveDocument({ ...ref, documentType: 'Playlist' });
    const sound = this.collectionToArray(playlist.sounds).find((candidate) => candidate.id === soundId || candidate.name === soundId);
    if (!sound) throw new Error(`Playlist sound "${soundId}" not found`);
    const method = action === 'play' ? 'playSound' : 'stopSound';
    if (typeof playlist[method] === 'function') return this.serialize(await playlist[method](sound), {});
    if (typeof sound[action] === 'function') return this.serialize(await sound[action](), {});
    throw new Error(`Playlist sound action "${action}" is not supported in this Foundry version`);
  }

  async cardsAction(ref: DocumentRef, action: 'shuffle' | 'draw'): Promise<any> {
    const cards = await this.resolveDocument({ ...ref, documentType: 'Cards' });
    if (action === 'shuffle' && typeof cards.shuffle === 'function') return this.serialize(await cards.shuffle(), {});
    if (action === 'draw' && typeof cards.draw === 'function') return this.serialize(await cards.draw(), {});
    throw new Error(`Cards action "${action}" is not supported in this Foundry version`);
  }

  async combatAction(ref: DocumentRef, action: 'advance'): Promise<any> {
    const combat = await this.resolveDocument({ ...ref, documentType: 'Combat' });
    if (action === 'advance' && typeof combat.nextTurn === 'function') return this.serialize(await combat.nextTurn(), {});
    throw new Error(`Combat action "${action}" is not supported in this Foundry version`);
  }

  async resolveDocument(ref: DocumentRef): Promise<any> {
    if (ref.uuid) {
      const doc = await (globalThis as any).fromUuid(ref.uuid);
      if (!doc) throw new Error(`Document not found for UUID ${ref.uuid}`);
      return doc;
    }

    if (ref.packId) {
      const pack = (game as any).packs?.get(ref.packId);
      if (!pack) throw new Error(`Compendium pack "${ref.packId}" not found`);
      if (!ref.id) throw new Error('Compendium document lookup requires id');
      const doc = await pack.getDocument(ref.id);
      if (!doc) throw new Error(`Document "${ref.id}" not found in pack "${ref.packId}"`);
      return doc;
    }

    if (!ref.documentType) {
      throw new Error('Document lookup requires uuid, packId+id, or documentType');
    }

    const collection = documentRegistry.getCollection(ref.documentType);
    const candidates = this.collectionToArray(collection);
    if (ref.id) {
      const found = candidates.find((doc) => doc?.id === ref.id || doc?._id === ref.id);
      if (!found) throw new Error(`${ref.documentType} "${ref.id}" not found`);
      return found;
    }

    if (ref.name) {
      const matches = candidates.filter((doc) => doc?.name === ref.name);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new Error(`Ambiguous ${ref.documentType} name "${ref.name}". Candidates: ${matches.map((doc) => `${doc.name} (${doc.id})`).join(', ')}`);
      }
      throw new Error(`${ref.documentType} named "${ref.name}" not found`);
    }

    throw new Error('Document lookup requires id or name when uuid is not provided');
  }

  private async resolveEmbeddedDocument(ref: EmbeddedDocumentRef): Promise<any> {
    const parent = await this.resolveDocument({ uuid: ref.parentUuid });
    const docs = this.collectionToArray(this.getEmbeddedCollection(parent, ref.embeddedType));

    if (ref.embeddedId) {
      const found = docs.find((doc) => doc?.id === ref.embeddedId || doc?._id === ref.embeddedId);
      if (!found) throw new Error(`${ref.embeddedType} "${ref.embeddedId}" not found`);
      return found;
    }

    if (ref.embeddedName) {
      const matches = docs.filter((doc) => doc?.name === ref.embeddedName);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new Error(`Ambiguous ${ref.embeddedType} name "${ref.embeddedName}"`);
      }
      throw new Error(`${ref.embeddedType} named "${ref.embeddedName}" not found`);
    }

    throw new Error('Embedded document lookup requires embeddedId or embeddedName');
  }

  private assertMutationAllowed(documentType: string, operation: string): void {
    const entry = documentRegistry.getEntry(documentType);
    if (entry.mutationPolicy !== 'full') {
      throw new Error(`${entry.documentType} is read-only through MCP in this phase`);
    }

    const check = permissionManager.checkWritePermission(entry.risk === 'high' ? 'highRisk.write' : operation);
    if (!check.allowed) {
      throw new Error(check.reason || `${operation} denied`);
    }
  }

  private assertEmbeddedMutationAllowed(parent: any, embeddedType: string): void {
    this.assertMutationAllowed(parent.documentName || 'Document', 'sceneEmbedded.modify');
    const allowedParents = documentRegistry.getEmbeddedParentTypes(embeddedType);
    if (allowedParents.length && !allowedParents.includes(parent.documentName)) {
      throw new Error(`${embeddedType} is not supported under parent ${parent.documentName}`);
    }
  }

  private serialize(value: unknown, options: DocumentSerializationOptions): any {
    const serialized = documentSerializer.serialize(value, options);
    return {
      ...((serialized.data && typeof serialized.data === 'object') ? serialized.data as Record<string, unknown> : { value: serialized.data }),
      truncated: serialized.truncated,
      truncatedPaths: serialized.truncatedPaths,
    };
  }

  private documentRef(doc: any): Record<string, unknown> {
    return {
      uuid: doc?.uuid,
      id: doc?.id,
      documentName: doc?.documentName,
      name: doc?.name,
    };
  }

  private async listPackDocuments(packId: string, documentType: string): Promise<any[]> {
    const pack = (game as any).packs?.get(packId);
    if (!pack) throw new Error(`Compendium pack "${packId}" not found`);
    if (documentType && pack.documentName && pack.documentName !== documentType) {
      throw new Error(`Pack "${packId}" contains ${pack.documentName}, not ${documentType}`);
    }
    if (typeof pack.getDocuments === 'function') return pack.getDocuments();
    return this.collectionToArray(await pack.getIndex());
  }

  private async createWithClass(documentClass: any, data: Record<string, unknown>): Promise<any> {
    if (typeof documentClass.createDocuments === 'function') {
      const created = await documentClass.createDocuments([data]);
      return Array.isArray(created) ? created[0] : created;
    }
    if (typeof documentClass.create === 'function') {
      return documentClass.create(data);
    }
    throw new Error(`Document class ${documentClass.name || 'Unknown'} cannot create documents`);
  }

  private getEmbeddedCollection(parent: any, embeddedType: string): any {
    if (typeof parent.getEmbeddedCollection === 'function') {
      return parent.getEmbeddedCollection(embeddedType);
    }

    const candidates = [
      embeddedType,
      `${embeddedType}s`,
      embeddedType.charAt(0).toLowerCase() + embeddedType.slice(1),
      `${embeddedType.charAt(0).toLowerCase()}${embeddedType.slice(1)}s`,
    ];
    for (const key of candidates) {
      if (parent[key]) return parent[key];
    }
    throw new Error(`${parent.documentName || 'Parent'} does not expose embedded collection ${embeddedType}`);
  }

  private collectionToArray(collection: any): any[] {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.map === 'function' && typeof collection.size === 'number') return collection.map((item: any) => item);
    if (typeof collection.values === 'function') return Array.from(collection.values());
    if (typeof collection[Symbol.iterator] === 'function') return Array.from(collection);
    return Object.values(collection);
  }

  private resolveAllowedRoot(root: string): any {
    const allowed = new Set([
      'game.actors',
      'game.items',
      'game.scenes',
      'game.journal',
      'game.macros',
      'game.tables',
      'game.playlists',
      'game.cards',
      'game.combats',
      'game.folders',
      'game.users',
      'game.messages',
      'game.settings.storage',
    ]);
    if (!allowed.has(root)) throw new Error(`Root "${root}" is not allowed`);

    let value: any = globalThis;
    for (const part of root.split('.')) {
      value = value?.[part];
    }
    return value;
  }

  private applyFilters(rows: any[], filters: Record<string, unknown>): any[] {
    const entries = Object.entries(filters);
    if (!entries.length) return rows;
    return rows.filter((row) => entries.every(([path, expected]) => {
      const actual = this.getPath(row, path);
      if (typeof expected === 'string' && typeof actual === 'string') {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      return actual === expected;
    }));
  }

  private sortRows(rows: any[], field: string, direction: 'asc' | 'desc'): any[] {
    const multiplier = direction === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const left = this.getPath(a, field);
      const right = this.getPath(b, field);
      return String(left ?? '').localeCompare(String(right ?? '')) * multiplier;
    });
  }

  private getPath(row: any, path: string): unknown {
    let current = row;
    for (const part of path.split('.')) {
      current = current?.[part];
      if (current === undefined) return undefined;
    }
    return current;
  }
}

export const documentService = new DocumentService();
