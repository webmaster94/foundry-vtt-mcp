import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {
  BackendConnectionStatus,
  BackendPingResult,
  BackendStatusResult,
  ReloadServersConfigResult,
} from '../shared/contracts.js';

interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
}

interface RpcResponse {
  id?: string;
  result?: unknown;
  error?: { message?: string; code?: string };
}

interface ToolEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  errorCode?: string;
}

export interface BackendControlClientOptions {
  host?: string;
  port?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  configPath?: string;
}

export class BackendRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'BackendRpcError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeConnection(value: unknown): BackendConnectionStatus {
  if (!isRecord(value)) throw new BackendRpcError('Backend returned an invalid server status row');
  return {
    name: asString(value.name),
    label: asString(value.label, asString(value.name)),
    host: asString(value.host, 'localhost'),
    port: asNumber(value.port),
    connectionType: asString(value.connectionType, 'auto'),
    remoteMode: asBoolean(value.remoteMode),
    active: asBoolean(value.active),
    connected: asBoolean(value.connected),
    connectionInfo: value.connectionInfo ?? null,
    cachedCapabilities:
      value.cachedCapabilities === null || isRecord(value.cachedCapabilities)
        ? (value.cachedCapabilities as BackendConnectionStatus['cachedCapabilities'])
        : null,
  };
}

function normalizePing(value: unknown): BackendPingResult {
  if (!isRecord(value) || value.ok !== true) {
    throw new BackendRpcError('Backend returned an invalid ping response');
  }
  return {
    ok: true,
    pid: asNumber(value.pid),
    startedAt: asString(value.startedAt),
    entrySig: asString(value.entrySig),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
    ...(typeof value.entryPath === 'string' ? { entryPath: value.entryPath } : {}),
  };
}

function normalizeStatus(value: unknown): BackendStatusResult {
  if (!isRecord(value) || !isRecord(value.backend) || !isRecord(value.config)) {
    throw new BackendRpcError('Backend returned an invalid status response');
  }
  const backend = value.backend;
  const config = value.config;
  const source = config.source === 'environment' ? 'environment' : 'file';
  return {
    protocolVersion: 1,
    backend: {
      pid: asNumber(backend.pid),
      startedAt: asString(backend.startedAt),
      entrySig: asString(backend.entrySig),
      ...(typeof backend.version === 'string' ? { version: backend.version } : {}),
      ...(typeof backend.instanceId === 'string' ? { instanceId: backend.instanceId } : {}),
      ...(typeof backend.entryPath === 'string' ? { entryPath: backend.entryPath } : {}),
    },
    config: {
      path: typeof config.path === 'string' ? config.path : null,
      exists: asBoolean(config.exists),
      source,
    },
    activeServer: asString(value.activeServer),
    servers: Array.isArray(value.servers) ? value.servers.map(normalizeConnection) : [],
  };
}

function parseToolEnvelope(value: unknown): unknown {
  if (!isRecord(value)) throw new BackendRpcError('Backend returned an invalid tool envelope');
  const envelope = value as ToolEnvelope;
  const text = envelope.content?.find(
    item => item.type === 'text' && typeof item.text === 'string'
  )?.text;
  if (envelope.isError) {
    throw new BackendRpcError(
      text?.replace(/^Error:\s*/, '') || 'Backend tool call failed',
      envelope.errorCode
    );
  }
  if (!text) throw new BackendRpcError('Backend tool response did not contain JSON text');
  try {
    return JSON.parse(text);
  } catch {
    throw new BackendRpcError('Backend tool response was not valid JSON');
  }
}

export class BackendControlClient {
  private readonly host: string;
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly configPath: string | undefined;

  constructor(options: BackendControlClientOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 31414;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.configPath = options.configPath;
  }

  async ping(): Promise<BackendPingResult> {
    return normalizePing(await this.request('ping', {}));
  }

  async getStatus(): Promise<BackendStatusResult> {
    try {
      return normalizeStatus(await this.request('get_status', {}));
    } catch (error) {
      if (!(error instanceof BackendRpcError) || !/unknown method/i.test(error.message))
        throw error;
      return this.getLegacyStatus();
    }
  }

  async setActiveServer(name: string): Promise<{ activeServer: string }> {
    try {
      const result = await this.request('set_active_server', { name });
      if (!isRecord(result))
        throw new BackendRpcError('Backend returned an invalid active-server response');
      return { activeServer: asString(result.activeServer, name) };
    } catch (error) {
      if (!(error instanceof BackendRpcError) || !/unknown method/i.test(error.message))
        throw error;
      const legacy = await this.callTool('use-foundry-server', { name });
      if (!isRecord(legacy))
        throw new BackendRpcError('Legacy backend returned an invalid active-server response');
      return { activeServer: asString(legacy.activeServer, name) };
    }
  }

  async reconnectServer(name?: string): Promise<{ server: string; restarted: true }> {
    const params = name ? { name } : {};
    try {
      const result = await this.request('reconnect_server', params);
      if (!isRecord(result))
        throw new BackendRpcError('Backend returned an invalid reconnect response');
      return { server: asString(result.server, name), restarted: true };
    } catch (error) {
      if (!(error instanceof BackendRpcError) || !/unknown method/i.test(error.message))
        throw error;
      const legacy = await this.callTool('reconnect-foundry-server', params);
      if (!isRecord(legacy))
        throw new BackendRpcError('Legacy backend returned an invalid reconnect response');
      return { server: asString(legacy.server, name), restarted: true };
    }
  }

  async reloadServersConfig(): Promise<ReloadServersConfigResult> {
    let raw: unknown;
    try {
      raw = await this.request('reload_servers_config', {});
    } catch (error) {
      if (!(error instanceof BackendRpcError) || !/unknown method/i.test(error.message))
        throw error;
      raw = await this.callTool('reload-foundry-servers-config', {});
    }
    if (!isRecord(raw))
      throw new BackendRpcError('Backend returned an invalid config-reload response');
    return {
      added: stringArray(raw.added),
      removed: stringArray(raw.removed),
      changed: stringArray(raw.changed),
      unchanged: stringArray(raw.unchanged),
      activeServer: asString(raw.activeServer),
      servers: Array.isArray(raw.servers)
        ? raw.servers.flatMap(server => {
            if (!isRecord(server)) return [];
            return [
              {
                name: asString(server.name),
                port: asNumber(server.port),
                connected: asBoolean(server.connected),
              },
            ];
          })
        : [],
    };
  }

  async shutdown(): Promise<{ ok: boolean }> {
    const result = await this.request('shutdown', {});
    return isRecord(result) ? { ok: result.ok === true } : { ok: false };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    const message: RpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let receivedBytes = 0;
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setEncoding('utf8');

      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        finish(new BackendRpcError(`Timed out waiting for backend RPC ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();

      socket.once('connect', () => {
        socket.write(`${JSON.stringify(message)}\n`, 'utf8');
      });
      socket.on('data', (chunk: string) => {
        receivedBytes += Buffer.byteLength(chunk, 'utf8');
        if (receivedBytes > this.maxResponseBytes) {
          finish(new BackendRpcError(`Backend RPC ${method} exceeded the response limit`));
          return;
        }
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        if (!line) return;
        try {
          const response = JSON.parse(line) as RpcResponse;
          if (response.id !== id) {
            finish(new BackendRpcError(`Backend RPC ${method} returned a mismatched response id`));
          } else if (response.error) {
            finish(
              new BackendRpcError(
                response.error.message || `Backend RPC ${method} failed`,
                response.error.code
              )
            );
          } else {
            finish(undefined, response.result);
          }
        } catch (error) {
          finish(
            new BackendRpcError(
              `Backend RPC ${method} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
      });
      socket.once('error', error => finish(error));
      socket.once('close', () => {
        if (!settled) finish(new BackendRpcError(`Backend disconnected during RPC ${method}`));
      });
    });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return parseToolEnvelope(await this.request('call_tool', { name, args }));
  }

  private async getLegacyStatus(): Promise<BackendStatusResult> {
    const [ping, toolStatus] = await Promise.all([
      this.ping(),
      this.callTool('list-foundry-servers', {}),
    ]);
    if (!isRecord(toolStatus))
      throw new BackendRpcError('Legacy backend returned an invalid status response');
    const configPath = this.configPath ?? null;
    return {
      protocolVersion: 1,
      backend: {
        pid: ping.pid,
        startedAt: ping.startedAt,
        entrySig: ping.entrySig,
        ...(ping.version ? { version: ping.version } : {}),
        ...(ping.instanceId ? { instanceId: ping.instanceId } : {}),
        ...(ping.entryPath ? { entryPath: ping.entryPath } : {}),
      },
      config: {
        path: configPath,
        exists: configPath ? fs.existsSync(configPath) : false,
        source: process.env.FOUNDRY_SERVERS_CONFIG ? 'environment' : 'file',
      },
      activeServer: asString(toolStatus.activeServer),
      servers: Array.isArray(toolStatus.servers) ? toolStatus.servers.map(normalizeConnection) : [],
    };
  }
}
