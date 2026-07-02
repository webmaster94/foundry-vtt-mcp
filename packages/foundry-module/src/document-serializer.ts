import { MODULE_ID } from './constants.js';

export interface DocumentSerializationOptions {
  fields?: string[];
  includeSystem?: boolean;
  includeFlags?: boolean;
  includeSource?: boolean;
  includeEmbedded?: boolean;
  maxBytes?: number;
}

export interface SerializedResult {
  data: unknown;
  truncated: boolean;
  truncatedPaths: string[];
}

const DEFAULT_MAX_BYTES = 256_000;

export class DocumentSerializer {
  serialize(value: unknown, options: DocumentSerializationOptions = {}): SerializedResult {
    const maxBytes = this.getMaxBytes(options.maxBytes);
    const truncatedPaths: string[] = [];
    const data = this.serializeValue(value, options, new WeakSet<object>(), '$', 0, truncatedPaths);
    const projected = options.fields?.length ? this.project(data, options.fields) : data;
    return this.enforceMaxBytes(projected, maxBytes, truncatedPaths);
  }

  private serializeValue(
    value: unknown,
    options: DocumentSerializationOptions,
    seen: WeakSet<object>,
    path: string,
    depth: number,
    truncatedPaths: string[]
  ): unknown {
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string') return value;
    if (valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'bigint') return String(value);
    if (valueType === 'symbol') return String(value);
    if (valueType === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;

    if (depth > 8) {
      truncatedPaths.push(path);
      return '[MaxDepth]';
    }

    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }

    if (value instanceof Node) {
      return this.serializeNode(value);
    }

    if (typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      if (seen.has(objectValue)) return '[Circular]';
      seen.add(objectValue);

      const documentLike = this.serializeDocumentLike(objectValue, options, seen, path, depth, truncatedPaths);
      if (documentLike) return documentLike;

      if (Array.isArray(value)) {
        return value.slice(0, 500).map((item, index) => this.serializeValue(item, options, seen, `${path}[${index}]`, depth + 1, truncatedPaths));
      }

      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(objectValue)) {
        if (this.shouldSkipKey(key)) continue;
        output[key] = this.serializeValue(child, options, seen, `${path}.${key}`, depth + 1, truncatedPaths);
      }
      return output;
    }

    return String(value);
  }

  private serializeDocumentLike(
    value: Record<string, unknown>,
    options: DocumentSerializationOptions,
    seen: WeakSet<object>,
    path: string,
    depth: number,
    truncatedPaths: string[]
  ): Record<string, unknown> | null {
    const documentName = this.stringProp(value, 'documentName') || this.stringProp(value.constructor as unknown as Record<string, unknown>, 'documentName');
    const uuid = this.stringProp(value, 'uuid');
    const id = this.stringProp(value, 'id');

    if (!documentName && !uuid && !id) {
      return null;
    }

    const source = this.getDocumentSource(value);
    const output: Record<string, unknown> = {
      id,
      uuid,
      documentName,
      name: this.stringProp(value, 'name'),
      type: this.stringProp(value, 'type'),
    };

    const img = this.stringProp(value, 'img');
    if (img) output.img = img;

    const folder = this.extractId(value.folder);
    if (folder) output.folder = folder;

    const ownership = value.ownership ?? source?.ownership;
    if (ownership) output.ownership = this.serializeValue(ownership, options, seen, `${path}.ownership`, depth + 1, truncatedPaths);

    if (options.includeSystem !== false) {
      const system = value.system ?? source?.system;
      if (system !== undefined) output.system = this.serializeValue(system, options, seen, `${path}.system`, depth + 1, truncatedPaths);
    }

    if (options.includeFlags) {
      const flags = value.flags ?? source?.flags;
      if (flags !== undefined) output.flags = this.serializeValue(flags, options, seen, `${path}.flags`, depth + 1, truncatedPaths);
    }

    if (options.includeEmbedded) {
      output.embedded = this.serializeEmbeddedSummary(value);
    }

    if (options.includeSource && source) {
      output._source = this.serializeValue(source, { ...options, includeSource: false }, seen, `${path}._source`, depth + 1, truncatedPaths);
    }

    return output;
  }

  private getDocumentSource(value: Record<string, unknown>): Record<string, unknown> | null {
    try {
      const toObject = value.toObject;
      if (typeof toObject === 'function') {
        return toObject.call(value) as Record<string, unknown>;
      }
    } catch {
      // Fall through to _source.
    }

    const source = value._source;
    return source && typeof source === 'object' ? source as Record<string, unknown> : null;
  }

  private serializeEmbeddedSummary(value: Record<string, unknown>): Record<string, number> {
    const output: Record<string, number> = {};
    const collections = value.collections;
    if (!collections || typeof collections !== 'object') return output;

    for (const [key, collection] of Object.entries(collections as Record<string, any>)) {
      output[key] = typeof collection?.size === 'number'
        ? collection.size
        : Array.isArray(collection)
          ? collection.length
          : 0;
    }
    return output;
  }

  private enforceMaxBytes(value: unknown, maxBytes: number, truncatedPaths: string[]): SerializedResult {
    let text = '';
    try {
      text = JSON.stringify(value);
    } catch {
      return {
        data: '[Unserializable]',
        truncated: true,
        truncatedPaths: ['$'],
      };
    }

    if (text.length <= maxBytes) {
      return {
        data: value,
        truncated: truncatedPaths.length > 0,
        truncatedPaths,
      };
    }

    return {
      data: {
        truncated: true,
        preview: text.slice(0, Math.max(128, maxBytes - 32)),
      },
      truncated: true,
      truncatedPaths: [...truncatedPaths, '$'],
    };
  }

  private project(value: unknown, fields: string[]): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.project(item, fields));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const selected = this.getPath(input, field);
      if (selected !== undefined) {
        this.setPath(output, field, selected);
      }
    }
    return output;
  }

  private getPath(value: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: any = value;
    for (const part of parts) {
      current = current?.[part];
      if (current === undefined) return undefined;
    }
    return current;
  }

  private setPath(value: Record<string, unknown>, path: string, selected: unknown): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = value;
    for (const part of parts.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = selected;
  }

  private serializeNode(value: Node): Record<string, unknown> {
    if (value instanceof Element) {
      return {
        nodeType: 'Element',
        tagName: value.tagName,
        id: value.id || undefined,
        className: typeof value.className === 'string' ? value.className : undefined,
      };
    }
    return { nodeType: value.nodeName };
  }

  private shouldSkipKey(key: string): boolean {
    return key.startsWith('_') && !['_id', '_source'].includes(key)
      || ['apps', 'sheet', 'rendered', 'element', 'canvas', 'texture', 'mesh'].includes(key);
  }

  private stringProp(value: Record<string, unknown> | undefined, key: string): string | undefined {
    const prop = value?.[key];
    return typeof prop === 'string' ? prop : undefined;
  }

  private extractId(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as any).id === 'string') return (value as any).id;
    return undefined;
  }

  private getMaxBytes(value: number | undefined): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.min(Math.max(value, 1000), 2_000_000);
    }

    try {
      const setting = Number(game.settings.get(MODULE_ID, 'documentResultMaxBytes'));
      return Number.isFinite(setting) ? Math.min(Math.max(setting, 1000), 2_000_000) : DEFAULT_MAX_BYTES;
    } catch {
      return DEFAULT_MAX_BYTES;
    }
  }
}

export const documentSerializer = new DocumentSerializer();
