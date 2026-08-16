import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Stable loopback endpoint shared by stdio wrappers and the desktop companion. */
export const CONTROL_HOST = '127.0.0.1';
export const CONTROL_PORT = 31414;
export const CONTROL_PROTOCOL_VERSION = 1;

export interface BackendPingResult {
  ok: true;
  pid: number;
  version: string;
  startedAt: string;
  entrySig: string;
  instanceId: string;
  entryPath: string;
}

export interface CachedModuleCapabilities {
  moduleId: string;
  moduleVersion: string;
  foundryVersion: string;
  system: { id: string; version: string };
  world: { id: string; title: string };
}

/** Safe status row. Deliberately excludes authToken and all other secrets. */
export interface BackendServerStatus {
  name: string;
  label: string;
  host: string;
  port: number;
  connectionType: string;
  remoteMode: boolean;
  active: boolean;
  connected: boolean;
  connectionInfo: unknown;
  cachedCapabilities: CachedModuleCapabilities | null;
}

export interface BackendStatusResult {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  backend: Omit<BackendPingResult, 'ok'>;
  config: {
    path: string | null;
    exists: boolean;
    source: 'file' | 'environment';
  };
  activeServer: string;
  servers: BackendServerStatus[];
}

export interface ReloadServersResult {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
  activeServer: string;
  servers: Array<{ name: string; port: number; connected: boolean }>;
}

export interface BackendControlMethods {
  ping: { params: Record<string, never>; result: BackendPingResult };
  shutdown: { params: Record<string, never>; result: { ok: true } };
  list_tools: { params: Record<string, never>; result: { tools: Tool[] } };
  call_tool: {
    params: { name: string; args?: unknown };
    result: {
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
      errorCode?: string;
    };
  };
  get_status: { params: Record<string, never>; result: BackendStatusResult };
  set_active_server: { params: { name: string }; result: { activeServer: string } };
  reconnect_server: {
    params: { name?: string };
    result: { server: string; restarted: true };
  };
  reload_servers_config: { params: Record<string, never>; result: ReloadServersResult };
}

export type BackendControlMethod = keyof BackendControlMethods;
export type BackendControlParams<M extends BackendControlMethod> =
  BackendControlMethods[M]['params'];
export type BackendControlResult<M extends BackendControlMethod> =
  BackendControlMethods[M]['result'];

export interface BackendControlRequest<M extends BackendControlMethod = BackendControlMethod> {
  id: string;
  method: M;
  params?: BackendControlParams<M>;
}

export interface BackendControlResponse<R = unknown> {
  id?: string;
  result?: R;
  error?: { message: string; code?: string };
}
