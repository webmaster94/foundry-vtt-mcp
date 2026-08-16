export type ConnectionType = 'websocket' | 'webrtc' | 'auto';

export interface ServerProfile {
  label?: string;
  host?: string;
  port?: number;
  namespace?: string;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  connectionTimeout?: number;
  connectionType?: ConnectionType;
  protocol?: 'ws' | 'wss';
  remoteMode?: boolean;
  rejectUnauthorized?: boolean;
  authToken?: string;
}

export interface ServersConfig {
  $comment?: string;
  defaultServer?: string;
  servers: Record<string, ServerProfile>;
}

export interface EditableServerProfile extends Omit<ServerProfile, 'authToken'> {
  authTokenConfigured: boolean;
}

export interface EditableServersConfig {
  $comment?: string;
  defaultServer?: string;
  servers: Record<string, EditableServerProfile>;
}

export type AuthTokenUpdate =
  | { mode: 'keep' }
  | { mode: 'clear' }
  | { mode: 'replace'; value: string };

export interface BackendIdentity {
  pid: number;
  version?: string;
  startedAt: string;
  entrySig: string;
  instanceId?: string;
  entryPath?: string;
}

export interface BackendPingResult extends BackendIdentity {
  ok: true;
}

export interface BackendConnectionStatus {
  name: string;
  label: string;
  host: string;
  port: number;
  connectionType: string;
  remoteMode: boolean;
  active: boolean;
  connected: boolean;
  connectionInfo: unknown;
  cachedCapabilities: {
    moduleId: string;
    moduleVersion: string;
    foundryVersion: string;
    system: { id: string; version: string };
    world: { id: string; title: string };
  } | null;
}

export interface BackendStatusResult {
  protocolVersion: 1;
  backend: BackendIdentity;
  config: {
    path: string | null;
    exists: boolean;
    source: 'file' | 'environment';
  };
  activeServer: string;
  servers: BackendConnectionStatus[];
}

export interface ReloadServersConfigResult {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
  activeServer: string;
  servers: Array<{ name: string; port: number; connected: boolean }>;
}

export type BackendRuntimeState = 'starting' | 'online' | 'offline' | 'stopping' | 'error';

export interface DesktopStatus {
  state: BackendRuntimeState;
  checkedAt: string;
  status: BackendStatusResult | null;
  message?: string;
}

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  hash: string | null;
  value: ServersConfig;
}

export interface SaveConfigRequest {
  value: unknown;
  expectedHash: string | null;
}

export interface SaveConfigResult extends ConfigSnapshot {
  previousHash: string | null;
  changed: boolean;
  backupPath: string | null;
}

export interface EditableConfigSnapshot {
  path: string;
  exists: boolean;
  hash: string | null;
  valid: boolean;
  value: EditableServersConfig;
  error?: string;
}

export interface SaveConnectionsRequest {
  value: unknown;
  expectedHash: string | null;
  authTokenUpdates: Record<string, AuthTokenUpdate>;
  replaceInvalid: boolean;
}

export interface SaveConnectionsResult extends EditableConfigSnapshot {
  valid: true;
  previousHash: string | null;
  changed: boolean;
  backupPath: string | null;
  /** True only after the managed backend confirms a reload of this file. */
  applied: boolean;
  /** Present when the file was saved but the live backend could not apply it. */
  applyError?: string;
}

export interface DesktopAppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  configPath: string;
}

export type NavigationTarget = 'overview' | 'connections';

export interface DesktopBridgeApi {
  getStatus(): Promise<DesktopStatus>;
  getConnectionsConfig(): Promise<EditableConfigSnapshot>;
  saveConnectionsConfig(request: SaveConnectionsRequest): Promise<SaveConnectionsResult>;
  getAppInfo(): Promise<DesktopAppInfo>;
  showConnections(): Promise<void>;
  openConfigFolder(): Promise<void>;
  onStatusChanged(listener: (status: DesktopStatus) => void): () => void;
  onNavigate(listener: (target: NavigationTarget) => void): () => void;
}

export const IPC_CHANNELS = {
  getStatus: 'desktop:status:get',
  statusChanged: 'desktop:status:changed',
  getConnectionsConfig: 'desktop:connections:get',
  saveConnectionsConfig: 'desktop:connections:save',
  showConnections: 'desktop:connections:show',
  openConfigFolder: 'desktop:connections:open-folder',
  getAppInfo: 'desktop:app-info:get',
  navigate: 'desktop:navigate',
} as const;

export const TRUSTED_EXTERNAL_URLS = {
  documentation: 'https://github.com/webmaster94/foundry-vtt-mcp',
  issues: 'https://github.com/webmaster94/foundry-vtt-mcp/issues',
} as const;
