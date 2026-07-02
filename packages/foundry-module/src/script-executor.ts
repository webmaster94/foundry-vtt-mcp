import { auditService } from './audit-service.js';
import { browserConsoleCapture } from './console-capture.js';
import { documentSerializer } from './document-serializer.js';
import { MODULE_ID } from './constants.js';

export interface FoundryScriptRequest {
  code: string;
  mode?: 'script' | 'expression';
  timeoutMs?: number;
  resultLimitBytes?: number;
  description?: string;
}

export class ScriptExecutor {
  async execute(request: FoundryScriptRequest): Promise<any> {
    if (!game.settings.get(MODULE_ID, 'enabled')) {
      throw new Error('MCP Bridge is disabled');
    }
    if (!game.user?.isGM) {
      throw new Error('Only a GM browser can execute Foundry scripts');
    }
    if (!game.settings.get(MODULE_ID, 'allowBrowserCodeExecution')) {
      throw new Error('Browser code execution is disabled in module settings');
    }

    const maxLength = Number(game.settings.get(MODULE_ID, 'scriptMaxLength') || 20_000);
    if (request.code.length > maxLength) {
      throw new Error(`Script length ${request.code.length} exceeds maximum ${maxLength}`);
    }

    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? Number(game.settings.get(MODULE_ID, 'scriptTimeoutMs') || 5000), 100), 30_000);
    const resultLimitBytes = Math.min(Math.max(request.resultLimitBytes ?? Number(game.settings.get(MODULE_ID, 'scriptResultMaxBytes') || 256_000), 1000), 2_000_000);
    const executionId = `script-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const mode = request.mode || 'script';
    const logs: unknown[] = [];
    const started = Date.now();
    const consoleSinceIdBefore = browserConsoleCapture.getStatus().nextId - 1;

    const log = (...args: unknown[]) => {
      logs.push(args.map((arg) => documentSerializer.serialize(arg, { maxBytes: 16_000 }).data));
      console.log(`[${MODULE_ID} ${executionId}]`, ...args);
    };

    browserConsoleCapture.setScriptExecutionId(executionId);

    try {
      const result = await this.withTimeout(this.runCode(request.code, mode, log), timeoutMs);
      const serialized = documentSerializer.serialize(result, { maxBytes: resultLimitBytes, includeSystem: true, includeFlags: true });
      const response = {
        executionId,
        success: true,
        result: serialized.data,
        logs,
        durationMs: Date.now() - started,
        consoleSinceIdBefore,
        consoleSinceIdAfter: browserConsoleCapture.getStatus().nextId - 1,
        truncated: serialized.truncated,
      };

      await auditService.record({
        operation: 'script.execute',
        toolName: 'execute-foundry-script',
        executionId,
        payloadSummary: { mode, description: request.description, codeLength: request.code.length },
        resultSummary: { success: true, truncated: serialized.truncated },
        durationMs: response.durationMs,
        success: true,
        scriptCode: request.code,
      });

      return response;
    } catch (error) {
      const response = {
        executionId,
        success: false,
        logs,
        durationMs: Date.now() - started,
        consoleSinceIdBefore,
        consoleSinceIdAfter: browserConsoleCapture.getStatus().nextId - 1,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };

      await auditService.record({
        operation: 'script.execute',
        toolName: 'execute-foundry-script',
        executionId,
        payloadSummary: { mode, description: request.description, codeLength: request.code.length },
        resultSummary: response,
        durationMs: response.durationMs,
        success: false,
        error: response.error,
        scriptCode: request.code,
      });

      return response;
    } finally {
      browserConsoleCapture.setScriptExecutionId(undefined);
    }
  }

  private async runCode(code: string, mode: 'script' | 'expression', log: (...args: unknown[]) => void): Promise<unknown> {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const context = this.createContext(log);
    const names = Object.keys(context);
    const values = Object.values(context);
    const body = mode === 'expression' ? `return (${code});` : code;
    const fn = new AsyncFunction(...names, body);
    return fn(...values);
  }

  private createContext(log: (...args: unknown[]) => void): Record<string, unknown> {
    return {
      game: (globalThis as any).game,
      canvas: (globalThis as any).canvas,
      ui: (globalThis as any).ui,
      foundry: (globalThis as any).foundry,
      CONFIG: (globalThis as any).CONFIG,
      CONST: (globalThis as any).CONST,
      Hooks: (globalThis as any).Hooks,
      fromUuid: (globalThis as any).fromUuid,
      Roll: (globalThis as any).Roll,
      ChatMessage: (globalThis as any).ChatMessage,
      Actor: (globalThis as any).Actor,
      Item: (globalThis as any).Item,
      Scene: (globalThis as any).Scene,
      Macro: (globalThis as any).Macro,
      log,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }
}

export const scriptExecutor = new ScriptExecutor();
