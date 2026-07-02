/**
 * System-data compendium search: filters on real system fields (spell level,
 * school, item type, rarity...) using indexed fields where possible, with
 * optional full-text search over descriptions (document-loading, capped).
 */

export interface ContentFilter {
  /** Dotted path into the index/document, e.g. "system.level" or "type". */
  path: string;
  /** eq (default), lte, gte, lt, gt, ne, in, contains (case-insensitive substring) */
  op?: 'eq' | 'lte' | 'gte' | 'lt' | 'gt' | 'ne' | 'in' | 'contains';
  value: unknown;
}

export interface ContentSearchRequest {
  /** Restrict to specific packs; otherwise all packs of documentType are searched. */
  packIds?: string[];
  documentType?: string; // default "Item"
  /** Case-insensitive substring match on entry name. */
  name?: string;
  filters?: ContentFilter[];
  /** Full-text (case-insensitive) search over description HTML. Loads documents — capped. */
  text?: string;
  /** Extra index fields to return with each result. */
  fields?: string[];
  limit?: number;
}

const TEXT_SEARCH_DOC_CAP = 2000;

export class CompendiumContentSearch {
  async search(request: ContentSearchRequest): Promise<any> {
    const documentType = request.documentType || 'Item';
    const limit = Math.min(Math.max(request.limit ?? 25, 1), 100);
    const filters = request.filters || [];

    const allPacks = ((game as any).packs?.contents || []).filter(
      (pack: any) => pack.documentName === documentType
    );
    const packs = request.packIds?.length
      ? allPacks.filter((pack: any) => request.packIds!.includes(pack.collection))
      : allPacks;

    if (!packs.length) {
      throw new Error(
        request.packIds?.length
          ? `No ${documentType} packs matched packIds ${request.packIds.join(', ')}`
          : `No compendium packs contain ${documentType} documents`
      );
    }

    // Fields we need in the index: filter paths + requested output fields.
    const indexFields = new Set<string>(['type']);
    for (const filter of filters) indexFields.add(filter.path);
    for (const field of request.fields || []) indexFields.add(field);

    const nameNeedle = request.name?.toLowerCase();
    const results: Array<Record<string, unknown>> = [];
    let scanned = 0;
    let docsLoaded = 0;
    let textCapHit = false;

    for (const pack of packs) {
      if (results.length >= limit) break;
      let index: any;
      try {
        index = await pack.getIndex({ fields: [...indexFields] });
      } catch {
        continue;
      }

      for (const entry of this.toArray(index)) {
        if (results.length >= limit) break;
        scanned++;

        if (
          nameNeedle &&
          !String(entry.name || '')
            .toLowerCase()
            .includes(nameNeedle)
        )
          continue;
        if (!filters.every(filter => this.matches(entry, filter))) continue;

        let description: string | undefined;
        if (request.text) {
          if (docsLoaded >= TEXT_SEARCH_DOC_CAP) {
            textCapHit = true;
            break;
          }
          docsLoaded++;
          const doc = await pack.getDocument(entry._id).catch(() => null);
          const raw = String(
            (doc as any)?.system?.description?.value ??
              (doc as any)?.system?.details?.biography?.value ??
              ''
          );
          if (!raw.toLowerCase().includes(request.text.toLowerCase())) continue;
          const plain = raw
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const at = plain.toLowerCase().indexOf(request.text.toLowerCase());
          description = plain.slice(Math.max(0, at - 80), at + request.text.length + 80);
        }

        const row: Record<string, unknown> = {
          id: entry._id,
          uuid: `Compendium.${pack.collection}.${documentType}.${entry._id}`,
          name: entry.name,
          type: entry.type,
          packId: pack.collection,
          packLabel: pack.metadata?.label,
        };
        for (const field of request.fields || []) {
          row[field] = this.getPath(entry, field);
        }
        if (description) row.match = `...${description}...`;
        results.push(row);
      }
    }

    return {
      documentType,
      packsSearched: packs.length,
      entriesScanned: scanned,
      count: results.length,
      limitReached: results.length >= limit,
      ...(textCapHit
        ? {
            warning: `Text search stopped after loading ${TEXT_SEARCH_DOC_CAP} documents; narrow with filters or packIds for full coverage.`,
          }
        : {}),
      results,
    };
  }

  private matches(entry: any, filter: ContentFilter): boolean {
    const actual = this.getPath(entry, filter.path);
    const op = filter.op || 'eq';
    switch (op) {
      case 'eq':
        return actual == filter.value; // loose: index numbers sometimes arrive as strings
      case 'ne':
        return actual != filter.value;
      case 'lte':
        return Number(actual) <= Number(filter.value);
      case 'gte':
        return Number(actual) >= Number(filter.value);
      case 'lt':
        return Number(actual) < Number(filter.value);
      case 'gt':
        return Number(actual) > Number(filter.value);
      case 'in':
        return Array.isArray(filter.value) && (filter.value as unknown[]).some(v => v == actual);
      case 'contains':
        return String(actual ?? '')
          .toLowerCase()
          .includes(String(filter.value ?? '').toLowerCase());
      default:
        return false;
    }
  }

  private getPath(row: any, path: string): unknown {
    let current = row;
    for (const part of path.split('.')) {
      current = current?.[part];
      if (current === undefined) return undefined;
    }
    return current;
  }

  private toArray(index: any): any[] {
    if (!index) return [];
    if (Array.isArray(index)) return index;
    if (typeof index.values === 'function') return Array.from(index.values());
    return Object.values(index);
  }
}

export const compendiumContentSearch = new CompendiumContentSearch();
