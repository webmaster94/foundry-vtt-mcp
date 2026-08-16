import type { BackendConnectionStatus, BackendStatusResult } from './contracts.js';

export interface ListenerFailure {
  message: string;
  at: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the bounded, secret-free listener failure published by FoundryClient. */
export function getListenerFailure(server: BackendConnectionStatus): ListenerFailure | null {
  if (!isRecord(server.connectionInfo) || !isRecord(server.connectionInfo.listener)) return null;
  const lastError = server.connectionInfo.listener.lastError;
  if (!isRecord(lastError) || typeof lastError.message !== 'string') return null;
  const message = lastError.message.trim();
  if (!message) return null;
  return {
    message: message.slice(0, 500),
    at: typeof lastError.at === 'number' && Number.isFinite(lastError.at) ? lastError.at : null,
  };
}

export function countListenerFailures(status: BackendStatusResult): number {
  return status.servers.filter(server => getListenerFailure(server) !== null).length;
}
