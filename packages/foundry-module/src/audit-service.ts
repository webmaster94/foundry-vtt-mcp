import { MODULE_ID } from './constants.js';

export interface AuditRecordInput {
  operation: string;
  toolName: string;
  executionId?: string;
  documentRefs?: Array<Record<string, unknown>>;
  payloadSummary?: unknown;
  resultSummary?: unknown;
  durationMs?: number;
  success: boolean;
  error?: string;
  scriptCode?: string;
}

export interface AuditLogEntry {
  id: number;
  timestamp: string;
  operation: string;
  toolName: string;
  executionId?: string;
  userId: string;
  userName: string;
  worldId: string;
  documentRefs: Array<Record<string, unknown>>;
  payloadSummary?: unknown;
  resultSummary?: unknown;
  durationMs?: number;
  success: boolean;
  error?: string;
  scriptHash?: string;
  scriptPreview?: string;
}

const AUDIT_SETTING = 'auditLogs';
const AUDIT_SEQUENCE_SETTING = 'auditLogSequence';

export class AuditService {
  private moduleId = MODULE_ID;

  async record(input: AuditRecordInput): Promise<void> {
    try {
      const entry = await this.createEntry(input);
      const logs = this.getLogsInternal();
      logs.push(entry);

      const retention = this.getRetention();
      if (logs.length > retention) {
        logs.splice(0, logs.length - retention);
      }

      await game.settings.set(this.moduleId, AUDIT_SETTING, logs);
      await game.settings.set(this.moduleId, AUDIT_SEQUENCE_SETTING, entry.id);
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to write audit log`, error);
    }
  }

  getLog(options: { limit?: number; operation?: string; success?: boolean } = {}): {
    entries: AuditLogEntry[];
    totalStored: number;
  } {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    let entries = this.getLogsInternal();

    if (options.operation) {
      entries = entries.filter(entry => entry.operation === options.operation);
    }

    if (typeof options.success === 'boolean') {
      entries = entries.filter(entry => entry.success === options.success);
    }

    return {
      entries: entries.slice(-limit),
      totalStored: entries.length,
    };
  }

  async clear(confirmClear: boolean): Promise<{ success: boolean; clearedCount: number }> {
    if (!confirmClear) {
      throw new Error('clear-mcp-audit-log requires confirmClear=true');
    }

    const clearedCount = this.getLogsInternal().length;
    await game.settings.set(this.moduleId, AUDIT_SETTING, []);
    await this.record({
      operation: 'audit.clear',
      toolName: 'clear-mcp-audit-log',
      success: true,
      resultSummary: { clearedCount },
    });

    return { success: true, clearedCount };
  }

  private async createEntry(input: AuditRecordInput): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: this.nextId(),
      timestamp: new Date().toISOString(),
      operation: input.operation,
      toolName: input.toolName,
      userId: game.user?.id || 'unknown',
      userName: game.user?.name || 'Unknown',
      worldId: game.world?.id || 'unknown',
      documentRefs: input.documentRefs || [],
      success: input.success,
    };

    if (input.executionId) entry.executionId = input.executionId;
    if (input.payloadSummary !== undefined)
      entry.payloadSummary = this.summarize(input.payloadSummary);
    if (input.resultSummary !== undefined)
      entry.resultSummary = this.summarize(input.resultSummary);
    if (input.durationMs !== undefined) entry.durationMs = input.durationMs;
    if (input.error) entry.error = input.error;

    if (input.scriptCode) {
      entry.scriptHash = await this.hash(input.scriptCode);
      entry.scriptPreview = input.scriptCode.slice(0, 200);
    }

    return entry;
  }

  private getLogsInternal(): AuditLogEntry[] {
    try {
      const logs = game.settings.get(this.moduleId, AUDIT_SETTING);
      return Array.isArray(logs) ? ([...logs] as AuditLogEntry[]) : [];
    } catch {
      return [];
    }
  }

  private nextId(): number {
    try {
      const current = Number(game.settings.get(this.moduleId, AUDIT_SEQUENCE_SETTING) || 0);
      return Number.isFinite(current) ? current + 1 : 1;
    } catch {
      return 1;
    }
  }

  private getRetention(): number {
    try {
      const value = Number(game.settings.get(this.moduleId, 'auditRetention'));
      return Number.isFinite(value) ? Math.min(Math.max(value, 1), 5000) : 500;
    } catch {
      return 500;
    }
  }

  private summarize(value: unknown): unknown {
    try {
      const text = JSON.stringify(value);
      if (text.length <= 4000) {
        return value;
      }
      return {
        truncated: true,
        preview: text.slice(0, 4000),
      };
    } catch {
      return String(value);
    }
  }

  private async hash(value: string): Promise<string> {
    try {
      const bytes = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      let hash = 0;
      for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
      }
      return `fallback-${Math.abs(hash).toString(16)}`;
    }
  }
}

export const auditService = new AuditService();
