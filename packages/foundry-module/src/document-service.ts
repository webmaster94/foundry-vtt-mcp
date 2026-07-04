import { auditService, type InverseOperation } from './audit-service.js';
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
      ? docs.filter(doc =>
          String(doc?.name || doc?.id || '')
            .toLowerCase()
            .includes(search)
        )
      : docs;
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);

    return {
      documentType: request.documentType,
      count: filtered.length,
      documents: filtered.slice(0, limit).map(doc => this.serialize(doc, request)),
    };
  }

  async getDocument(request: { ref: DocumentRef } & DocumentSerializationOptions): Promise<any> {
    const doc = await this.resolveDocument(request.ref);
    return this.serialize(doc, request);
  }

  async createDocument(
    request: {
      documentType: string;
      data: Record<string, unknown>;
      confirmBulkOperation?: boolean;
    } & DocumentSerializationOptions
  ): Promise<any> {
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
        ...this.groupOf(request),
        inverse: {
          kind: 'delete',
          documentType: request.documentType,
          ref: { uuid: created?.uuid, id: created?.id, documentType: request.documentType },
        },
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

  async updateDocument(
    request: {
      ref: DocumentRef;
      updates: Record<string, unknown>;
      dryRun?: boolean;
    } & DocumentSerializationOptions
  ): Promise<any> {
    const doc = await this.resolveDocument(request.ref);
    this.assertMutationAllowed(
      doc.documentName || request.ref.documentType || 'Document',
      'document.update'
    );
    const start = Date.now();

    const priorValues = this.capturePriorValues(doc, request.updates);
    if (request.dryRun) {
      return {
        dryRun: true,
        document: this.documentRef(doc),
        diff: this.buildDiff(priorValues, request.updates),
        note: 'No changes were applied. Re-run without dryRun to commit.',
      };
    }

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
        ...this.groupOf(request),
        inverse: {
          kind: 'update',
          ref: { uuid: doc.uuid },
          updates: priorValues,
        },
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

  async deleteDocument(request: {
    ref: DocumentRef;
    confirmDeletion?: boolean;
    dryRun?: boolean;
  }): Promise<any> {
    const doc = await this.resolveDocument(request.ref);
    this.assertMutationAllowed(
      doc.documentName || request.ref.documentType || 'Document',
      'document.delete'
    );
    const ref = this.documentRef(doc);

    if (request.dryRun) {
      return {
        dryRun: true,
        wouldDelete: ref,
        embeddedCounts: this.embeddedCounts(doc),
        note: 'No changes were applied. Re-run with confirmDeletion=true (without dryRun) to commit.',
      };
    }

    if (!request.confirmDeletion) {
      throw new Error('Deletion requires confirmDeletion=true');
    }

    const snapshot = this.snapshotForUndo(doc);
    const start = Date.now();

    try {
      await doc.delete();
      const result = { success: true, deleted: ref };
      const inverse: InverseOperation | undefined = snapshot
        ? { kind: 'create', documentType: doc.documentName, data: snapshot }
        : undefined;
      await auditService.record({
        operation: 'document.delete',
        toolName: 'delete-document',
        documentRefs: [ref],
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
        ...this.groupOf(request),
        ...(inverse ? { inverse } : {}),
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

  async listEmbeddedDocuments(
    request: {
      parentUuid: string;
      embeddedType: string;
      search?: string;
      limit?: number;
    } & DocumentSerializationOptions
  ): Promise<any> {
    const parent = await this.resolveDocument({ uuid: request.parentUuid });
    const collection = this.getEmbeddedCollection(parent, request.embeddedType);
    const docs = this.collectionToArray(collection);
    const search = request.search?.toLowerCase();
    const filtered = search
      ? docs.filter(doc =>
          String(doc?.name || doc?.id || '')
            .toLowerCase()
            .includes(search)
        )
      : docs;
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);

    return {
      parent: this.documentRef(parent),
      embeddedType: request.embeddedType,
      count: filtered.length,
      documents: filtered.slice(0, limit).map(doc => this.serialize(doc, request)),
    };
  }

  async getEmbeddedDocument(
    request: { ref: EmbeddedDocumentRef } & DocumentSerializationOptions
  ): Promise<any> {
    const doc = await this.resolveEmbeddedDocument(request.ref);
    return this.serialize(doc, request);
  }

  async createEmbeddedDocument(
    request: {
      parentUuid: string;
      embeddedType: string;
      data: Record<string, unknown>;
      confirmBulkOperation?: boolean;
    } & DocumentSerializationOptions
  ): Promise<any> {
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
        ...this.groupOf(request),
        inverse: {
          kind: 'embedded-delete',
          parentUuid: request.parentUuid,
          embeddedType: request.embeddedType,
          ref: { embeddedId: doc?.id },
        },
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

  /** Create several embedded documents under one parent in a single Foundry call. */
  async createEmbeddedDocuments(
    request: {
      parentUuid: string;
      embeddedType: string;
      data: Array<Record<string, unknown>>;
    } & DocumentSerializationOptions
  ): Promise<any> {
    if (!Array.isArray(request.data) || request.data.length === 0) {
      throw new Error('createEmbeddedDocuments requires a non-empty data array');
    }
    if (request.data.length > 100) {
      throw new Error('createEmbeddedDocuments is limited to 100 documents per call');
    }

    const parent = await this.resolveDocument({ uuid: request.parentUuid });
    this.assertEmbeddedMutationAllowed(parent, request.embeddedType);
    const start = Date.now();

    try {
      const created = await parent.createEmbeddedDocuments(request.embeddedType, request.data);
      const docs = Array.isArray(created) ? created : [created];
      const result = {
        parent: this.documentRef(parent),
        embeddedType: request.embeddedType,
        count: docs.length,
        documents: docs.map(doc => this.serialize(doc, request)),
      };
      await auditService.record({
        operation: 'embedded.createMany',
        toolName: 'create-embedded-documents',
        documentRefs: [this.documentRef(parent), ...docs.map(doc => this.documentRef(doc))],
        payloadSummary: { embeddedType: request.embeddedType, count: request.data.length },
        resultSummary: { count: docs.length },
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await auditService.record({
        operation: 'embedded.createMany',
        toolName: 'create-embedded-documents',
        documentRefs: [this.documentRef(parent)],
        payloadSummary: { embeddedType: request.embeddedType, count: request.data.length },
        durationMs: Date.now() - start,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async updateEmbeddedDocument(
    request: {
      ref: EmbeddedDocumentRef;
      updates: Record<string, unknown>;
      dryRun?: boolean;
    } & DocumentSerializationOptions
  ): Promise<any> {
    const parent = await this.resolveDocument({ uuid: request.ref.parentUuid });
    this.assertEmbeddedMutationAllowed(parent, request.ref.embeddedType);
    const doc = await this.resolveEmbeddedDocument(request.ref);
    const start = Date.now();

    const priorValues = this.capturePriorValues(doc, request.updates);
    if (request.dryRun) {
      return {
        dryRun: true,
        parent: this.documentRef(parent),
        document: this.documentRef(doc),
        diff: this.buildDiff(priorValues, request.updates),
        note: 'No changes were applied. Re-run without dryRun to commit.',
      };
    }

    try {
      const updated = await parent.updateEmbeddedDocuments(request.ref.embeddedType, [
        { _id: doc.id, ...request.updates },
      ]);
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
        ...this.groupOf(request),
        inverse: {
          kind: 'embedded-update',
          parentUuid: request.ref.parentUuid,
          embeddedType: request.ref.embeddedType,
          ref: { embeddedId: doc.id },
          updates: priorValues,
        },
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

  async deleteEmbeddedDocument(request: {
    ref: EmbeddedDocumentRef;
    confirmDeletion?: boolean;
  }): Promise<any> {
    if (!request.confirmDeletion) {
      throw new Error('Deletion requires confirmDeletion=true');
    }

    const parent = await this.resolveDocument({ uuid: request.ref.parentUuid });
    this.assertEmbeddedMutationAllowed(parent, request.ref.embeddedType);
    const doc = await this.resolveEmbeddedDocument(request.ref);
    const ref = this.documentRef(doc);
    const snapshot = this.snapshotForUndo(doc);
    const start = Date.now();

    try {
      await parent.deleteEmbeddedDocuments(request.ref.embeddedType, [doc.id]);
      const result = { success: true, deleted: ref };
      const inverse: InverseOperation | undefined = snapshot
        ? {
            kind: 'embedded-create',
            parentUuid: request.ref.parentUuid,
            embeddedType: request.ref.embeddedType,
            data: snapshot,
          }
        : undefined;
      await auditService.record({
        operation: 'embedded.delete',
        toolName: 'delete-embedded-document',
        documentRefs: [this.documentRef(parent), ref],
        resultSummary: result,
        durationMs: Date.now() - start,
        success: true,
        ...this.groupOf(request),
        ...(inverse ? { inverse } : {}),
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

    const fields: Array<Record<string, unknown>> = [];
    const walk = (schemaFields: any, prefix: string, depth: number): void => {
      if (!schemaFields || depth > 4) return;
      for (const [key, field] of Object.entries<any>(schemaFields)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const summary: Record<string, unknown> = {
          path,
          type: field?.constructor?.name?.replace(/Field$/, '') || 'unknown',
        };
        if (field?.required) summary.required = true;
        if (field?.nullable) summary.nullable = true;
        if (field?.readonly) summary.readonly = true;
        if (field?.label) summary.label = field.label;
        if (Array.isArray(field?.choices)) summary.choices = field.choices;
        if (typeof field?.min === 'number') summary.min = field.min;
        if (typeof field?.max === 'number') summary.max = field.max;
        if (field?.initial !== undefined && typeof field.initial !== 'function') {
          summary.initial = field.initial;
        }
        fields.push(summary);
        if (field?.fields) walk(field.fields, path, depth + 1);
      }
    };
    walk(documentClass?.schema?.fields, '', 0);

    // Subtypes and their system-data templates (e.g. dnd5e npc/character)
    const types: string[] = Array.isArray(documentClass?.TYPES)
      ? documentClass.TYPES.filter((type: string) => type !== 'base')
      : [];
    const systemTemplates: Record<string, string[]> = {};
    const models = (game as any).model?.[documentType];
    if (models) {
      for (const [type, template] of Object.entries<any>(models)) {
        systemTemplates[type] = Object.keys(template || {});
      }
    }

    return {
      documentType: entry.documentType,
      collection: (entry as any).collectionPath ?? (entry as any).collection ?? null,
      mutationPolicy: entry.mutationPolicy,
      embeddedTypes: entry.embeddedTypes,
      risk: entry.risk,
      className: documentClass?.name || null,
      types,
      fields,
      systemTemplates,
      hint: 'Use dotted paths from `fields` in update payloads. `systemTemplates` lists top-level system.* keys per subtype; inspect an existing document for full system data shape.',
    };
  }

  /**
   * Execute a sequence of document operations in order. Stops at the first
   * failure unless continueOnError is set. Not transactional — completed
   * operations stay applied — but each is individually undoable.
   */
  async batchOperations(request: {
    operations: Array<{
      action:
        | 'create'
        | 'update'
        | 'delete'
        | 'createEmbedded'
        | 'createEmbeddedMany'
        | 'updateEmbedded'
        | 'deleteEmbedded';
      [key: string]: unknown;
    }>;
    continueOnError?: boolean;
  }): Promise<any> {
    if (!Array.isArray(request.operations) || request.operations.length === 0) {
      throw new Error('batchOperations requires a non-empty operations array');
    }
    if (request.operations.length > 50) {
      throw new Error('batchOperations is limited to 50 operations per call');
    }

    // Every op in a batch shares one audit group so the whole batch can be
    // reverted with undo-last-mcp-operation { groupId }
    const groupId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const results: Array<Record<string, unknown>> = [];
    for (let index = 0; index < request.operations.length; index++) {
      const op = { ...(request.operations[index]! as any), groupId };
      try {
        let result: unknown;
        switch (op.action) {
          case 'create':
            result = await this.createDocument(op);
            break;
          case 'update':
            result = await this.updateDocument(op);
            break;
          case 'delete':
            result = await this.deleteDocument(op);
            break;
          case 'createEmbedded':
            result = await this.createEmbeddedDocument(op);
            break;
          case 'createEmbeddedMany':
            result = await this.createEmbeddedDocuments(op);
            break;
          case 'updateEmbedded':
            result = await this.updateEmbeddedDocument(op);
            break;
          case 'deleteEmbedded':
            result = await this.deleteEmbeddedDocument(op);
            break;
          default:
            throw new Error(`Unknown batch action "${op.action}"`);
        }
        results.push({ index, action: op.action, success: true, result });
      } catch (error) {
        results.push({
          index,
          action: op.action,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!request.continueOnError) break;
      }
    }

    const failed = results.filter(r => !r.success).length;
    return {
      total: request.operations.length,
      executed: results.length,
      succeeded: results.length - failed,
      failed,
      stoppedEarly: results.length < request.operations.length,
      groupId,
      undoHint: `Revert the whole batch with undo-last-mcp-operation { groupId: "${groupId}", confirmUndo: true }`,
      results,
    };
  }

  /**
   * Revert an undoable write: the most recent one by default, a specific
   * audit entry via auditId, or a whole group (batch/builder run) via groupId
   * — group entries revert in reverse order.
   */
  async undoLastOperation(
    request: { confirmUndo?: boolean; auditId?: number; groupId?: string } = {}
  ): Promise<any> {
    if (!request.confirmUndo) {
      throw new Error('undo requires confirmUndo=true');
    }

    if (request.groupId) {
      const entries = auditService.getGroupUndoable(request.groupId);
      if (!entries.length) {
        throw new Error(`No undoable operations found for group "${request.groupId}"`);
      }
      const results: Array<Record<string, unknown>> = [];
      for (const entry of entries) {
        try {
          const result = await this.applyInverse(entry);
          await auditService.markUndone(entry.id);
          results.push({ id: entry.id, operation: entry.operation, success: true, result });
        } catch (error) {
          results.push({
            id: entry.id,
            operation: entry.operation,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await auditService.record({
        operation: 'document.undoGroup',
        toolName: 'undo-last-mcp-operation',
        payloadSummary: { groupId: request.groupId, entries: entries.length },
        resultSummary: { undone: results.filter(r => r.success).length },
        success: true,
      });
      return { success: true, groupId: request.groupId, undone: results };
    }

    const entry = request.auditId
      ? auditService.getEntry(request.auditId)
      : auditService.getLastUndoable();
    if (!entry) {
      throw new Error(
        request.auditId
          ? `Audit entry ${request.auditId} not found`
          : 'No undoable operation found in the audit log'
      );
    }
    if (!entry.inverse || entry.undone || !entry.success) {
      throw new Error(
        `Audit entry ${entry.id} is not undoable (no inverse, already undone, or failed)`
      );
    }

    const start = Date.now();
    const result = await this.applyInverse(entry);

    await auditService.markUndone(entry.id);
    await auditService.record({
      operation: 'document.undo',
      toolName: 'undo-last-mcp-operation',
      payloadSummary: { undoneEntryId: entry.id, undoneOperation: entry.operation },
      resultSummary: result,
      durationMs: Date.now() - start,
      success: true,
    });

    return {
      success: true,
      undoneEntry: { id: entry.id, operation: entry.operation, timestamp: entry.timestamp },
      result,
    };
  }

  private async applyInverse(entry: { inverse?: InverseOperation }): Promise<unknown> {
    const inverse = entry.inverse!;
    let result: unknown;

    switch (inverse.kind) {
      case 'delete': {
        const doc = await this.resolveDocument(inverse.ref as DocumentRef);
        await doc.delete();
        result = { undone: 'create', deleted: this.documentRef(doc) };
        break;
      }
      case 'update': {
        const doc = await this.resolveDocument(inverse.ref as DocumentRef);
        await doc.update(inverse.updates || {});
        result = { undone: 'update', restored: this.documentRef(doc), values: inverse.updates };
        break;
      }
      case 'create': {
        const documentClass = documentRegistry.getDocumentClass(inverse.documentType || '');
        if (!documentClass) throw new Error(`Cannot recreate ${inverse.documentType}`);
        const created = await this.createWithClass(documentClass, inverse.data || {});
        result = { undone: 'delete', recreated: this.documentRef(created) };
        break;
      }
      case 'embedded-delete': {
        const parent = await this.resolveDocument({ uuid: this.requireUuid(inverse.parentUuid) });
        await parent.deleteEmbeddedDocuments(inverse.embeddedType, [
          (inverse.ref as any)?.embeddedId,
        ]);
        result = { undone: 'embedded-create', parent: this.documentRef(parent) };
        break;
      }
      case 'embedded-update': {
        const parent = await this.resolveDocument({ uuid: this.requireUuid(inverse.parentUuid) });
        await parent.updateEmbeddedDocuments(inverse.embeddedType, [
          { _id: (inverse.ref as any)?.embeddedId, ...(inverse.updates || {}) },
        ]);
        result = { undone: 'embedded-update', parent: this.documentRef(parent) };
        break;
      }
      case 'embedded-create': {
        const parent = await this.resolveDocument({ uuid: this.requireUuid(inverse.parentUuid) });
        const created = await parent.createEmbeddedDocuments(inverse.embeddedType, [
          inverse.data || {},
        ]);
        const doc = Array.isArray(created) ? created[0] : created;
        result = { undone: 'embedded-delete', recreated: this.documentRef(doc) };
        break;
      }
      default:
        throw new Error(`Unknown inverse kind "${(inverse as any).kind}"`);
    }

    return result;
  }

  async executeMacro(request: {
    uuid?: string;
    id?: string;
    name?: string;
    actorUuid?: string;
    tokenId?: string;
    speaker?: Record<string, unknown>;
  }): Promise<any> {
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
      if (request.tokenId && (globalThis as any).canvas?.tokens)
        scope.token = (globalThis as any).canvas.tokens.get(request.tokenId);
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

  async queryFoundryData(
    request: {
      root: string;
      filters?: Record<string, unknown>;
      fields?: string[];
      sort?: { field: string; direction?: 'asc' | 'desc' };
      limit?: number;
    } & DocumentSerializationOptions
  ): Promise<any> {
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
      rows: rows.slice(0, limit).map(row => this.serialize(row, serializationOptions)),
    };
  }

  async rollRollTable(ref: DocumentRef): Promise<any> {
    const table = await this.resolveDocument({ ...ref, documentType: 'RollTable' });
    if (typeof table.draw === 'function') return this.serialize(await table.draw(), {});
    if (typeof table.roll === 'function') return this.serialize(await table.roll(), {});
    throw new Error('RollTable does not support draw() or roll() in this Foundry version');
  }

  async playlistSoundAction(
    ref: DocumentRef,
    soundId: string,
    action: 'play' | 'stop'
  ): Promise<any> {
    const playlist = await this.resolveDocument({ ...ref, documentType: 'Playlist' });
    const sound = this.collectionToArray(playlist.sounds).find(
      candidate => candidate.id === soundId || candidate.name === soundId
    );
    if (!sound) throw new Error(`Playlist sound "${soundId}" not found`);
    const method = action === 'play' ? 'playSound' : 'stopSound';
    if (typeof playlist[method] === 'function')
      return this.serialize(await playlist[method](sound), {});
    if (typeof sound[action] === 'function') return this.serialize(await sound[action](), {});
    throw new Error(`Playlist sound action "${action}" is not supported in this Foundry version`);
  }

  async cardsAction(ref: DocumentRef, action: 'shuffle' | 'draw'): Promise<any> {
    const cards = await this.resolveDocument({ ...ref, documentType: 'Cards' });
    if (action === 'shuffle' && typeof cards.shuffle === 'function')
      return this.serialize(await cards.shuffle(), {});
    if (action === 'draw' && typeof cards.draw === 'function')
      return this.serialize(await cards.draw(), {});
    throw new Error(`Cards action "${action}" is not supported in this Foundry version`);
  }

  async combatAction(ref: DocumentRef, action: 'advance'): Promise<any> {
    const combat = await this.resolveDocument({ ...ref, documentType: 'Combat' });
    if (action === 'advance' && typeof combat.nextTurn === 'function')
      return this.serialize(await combat.nextTurn(), {});
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
      const found = candidates.find(doc => doc?.id === ref.id || doc?._id === ref.id);
      if (!found) throw new Error(`${ref.documentType} "${ref.id}" not found`);
      return found;
    }

    if (ref.name) {
      const matches = candidates.filter(doc => doc?.name === ref.name);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new Error(
          `Ambiguous ${ref.documentType} name "${ref.name}". Candidates: ${matches.map(doc => `${doc.name} (${doc.id})`).join(', ')}`
        );
      }
      throw new Error(`${ref.documentType} named "${ref.name}" not found`);
    }

    throw new Error('Document lookup requires id or name when uuid is not provided');
  }

  private async resolveEmbeddedDocument(ref: EmbeddedDocumentRef): Promise<any> {
    const parent = await this.resolveDocument({ uuid: ref.parentUuid });
    const docs = this.collectionToArray(this.getEmbeddedCollection(parent, ref.embeddedType));

    if (ref.embeddedId) {
      const found = docs.find(doc => doc?.id === ref.embeddedId || doc?._id === ref.embeddedId);
      if (!found) throw new Error(`${ref.embeddedType} "${ref.embeddedId}" not found`);
      return found;
    }

    if (ref.embeddedName) {
      const matches = docs.filter(doc => doc?.name === ref.embeddedName);
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

    const check = permissionManager.checkWritePermission(
      entry.risk === 'high' ? 'highRisk.write' : operation
    );
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
      ...(serialized.data && typeof serialized.data === 'object'
        ? (serialized.data as Record<string, unknown>)
        : { value: serialized.data }),
      truncated: serialized.truncated,
      truncatedPaths: serialized.truncatedPaths,
    };
  }

  /** Optional audit group tag threaded through requests (batches, builders). */
  private groupOf(request: unknown): { groupId?: string } {
    const groupId = (request as any)?.groupId;
    return typeof groupId === 'string' && groupId ? { groupId } : {};
  }

  private requireUuid(uuid: string | undefined): string {
    if (!uuid) throw new Error('Inverse operation is missing its parentUuid; cannot undo');
    return uuid;
  }

  /**
   * For every dotted path in `updates`, capture the document's current value
   * so the change can be reverted (missing values become null).
   */
  private capturePriorValues(doc: any, updates: Record<string, unknown>): Record<string, unknown> {
    const flat = this.flattenUpdates(updates);
    const prior: Record<string, unknown> = {};
    const utils = (globalThis as any).foundry?.utils;
    for (const path of Object.keys(flat)) {
      const current = utils?.getProperty ? utils.getProperty(doc, path) : this.getPath(doc, path);
      prior[path] = current === undefined ? null : this.plainClone(current);
    }
    return prior;
  }

  private buildDiff(
    prior: Record<string, unknown>,
    updates: Record<string, unknown>
  ): Record<string, { from: unknown; to: unknown }> {
    const flat = this.flattenUpdates(updates);
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const [path, to] of Object.entries(flat)) {
      diff[path] = { from: prior[path], to };
    }
    return diff;
  }

  private flattenUpdates(updates: Record<string, unknown>): Record<string, unknown> {
    const utils = (globalThis as any).foundry?.utils;
    if (utils?.flattenObject) {
      try {
        return utils.flattenObject(updates);
      } catch {
        // fall through to the manual implementation
      }
    }
    const out: Record<string, unknown> = {};
    const walk = (value: unknown, prefix: string): void => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, prefix ? `${prefix}.${key}` : key);
        }
      } else {
        out[prefix] = value;
      }
    };
    walk(updates, '');
    return out;
  }

  /** Full toObject snapshot for undo, skipped above 200KB to protect world settings. */
  private snapshotForUndo(doc: any): Record<string, unknown> | null {
    try {
      const data = typeof doc.toObject === 'function' ? doc.toObject() : null;
      if (!data) return null;
      if (JSON.stringify(data).length > 200_000) return null;
      return data;
    } catch {
      return null;
    }
  }

  private plainClone(value: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  private embeddedCounts(doc: any): Record<string, number> {
    const counts: Record<string, number> = {};
    const entry = documentRegistry.getEntry(doc.documentName || '');
    for (const embeddedType of entry?.embeddedTypes || []) {
      try {
        counts[embeddedType] = this.collectionToArray(
          this.getEmbeddedCollection(doc, embeddedType)
        ).length;
      } catch {
        // collection not exposed for this type
      }
    }
    return counts;
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
    throw new Error(
      `${parent.documentName || 'Parent'} does not expose embedded collection ${embeddedType}`
    );
  }

  private collectionToArray(collection: any): any[] {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.map === 'function' && typeof collection.size === 'number')
      return collection.map((item: any) => item);
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
    return rows.filter(row =>
      entries.every(([path, expected]) => {
        const actual = this.getPath(row, path);
        if (typeof expected === 'string' && typeof actual === 'string') {
          return actual.toLowerCase().includes(expected.toLowerCase());
        }
        return actual === expected;
      })
    );
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
