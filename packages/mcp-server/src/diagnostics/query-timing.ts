import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { getOperationSafety, type OperationSafety } from '@foundry-mcp/shared';
import { BridgeError } from '../bridge-errors.js';

export interface QueryTiming {
  operation: string;
  safety: OperationSafety;
  roundTripMs: number;
  outcome: 'success' | 'error';
  foundryExecutionMs?: number;
}

export interface ToolObservation {
  tool: string;
  durationMs: number;
  outcome: 'success' | 'error';
  errorCode?: string;
  queries: QueryTiming[];
  omittedQueries: number;
}

interface Trace {
  queries: QueryTiming[];
  omittedQueries: number;
}
const traces = new AsyncLocalStorage<Trace>();
const safeName = (name: string) => (/^[a-zA-Z0-9._-]{1,100}$/.test(name) ? name : 'unknown');

/** A captured completion callback retains the initiating tool across socket events. */
export function beginQueryTiming(method: string) {
  const trace = traces.getStore();
  const startedAt = performance.now();
  let finished = false;
  return (outcome: 'success' | 'error', moduleMs?: unknown) => {
    if (!trace || finished) return;
    finished = true;
    const roundTripMs = Math.max(0, performance.now() - startedAt);
    if (trace.queries.length >= 64) {
      trace.omittedQueries++;
      return;
    }
    const foundryExecutionMs =
      typeof moduleMs === 'number' &&
      Number.isFinite(moduleMs) &&
      moduleMs >= 0 &&
      moduleMs <= roundTripMs + 5
        ? moduleMs
        : undefined;
    trace.queries.push({
      operation: safeName(method),
      safety: getOperationSafety(method),
      roundTripMs,
      outcome,
      ...(foundryExecutionMs === undefined ? {} : { foundryExecutionMs }),
    });
  };
}

/** Observation failures must not change a tool's result or trigger another execution. */
export async function observeTool<T>(
  tool: string,
  execute: () => Promise<T>,
  observe: (observation: ToolObservation, error?: unknown) => void
): Promise<T> {
  const trace: Trace = { queries: [], omittedQueries: 0 };
  const startedAt = performance.now();
  return traces.run(trace, async () => {
    let outcome: 'success' | 'error' = 'success';
    let caught: unknown;
    try {
      return await execute();
    } catch (error) {
      outcome = 'error';
      caught = error;
      throw error;
    } finally {
      try {
        observe(
          {
            tool: safeName(tool),
            durationMs: Math.max(0, performance.now() - startedAt),
            outcome,
            ...(caught instanceof BridgeError ? { errorCode: caught.code } : {}),
            queries: trace.queries,
            omittedQueries: trace.omittedQueries,
          },
          caught
        );
      } catch {
        /* Diagnostic sinks are best effort. */
      }
    }
  });
}
