import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from './logger.js';
import { Config } from './config.js';
import { FoundryClient } from './foundry-client.js';

/**
 * Per-call server override. backend.ts wraps each tool invocation in
 * runWithServer(name, ...) when the caller passes a `server` argument, so any
 * tool can target a specific profile without the tool knowing about routing.
 */
const serverContext = new AsyncLocalStorage<string>();

export function runWithServer<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
  return serverContext.run(serverName, fn);
}

/**
 * Multi-server support: named Foundry connection profiles.
 *
 * Each profile gets its own FoundryClient (and therefore its own listener
 * port) so several Foundry instances can stay connected at once. Tools talk
 * to a single RoutingFoundryClient facade that always delegates to the
 * currently active profile, so individual tools need no changes.
 *
 * Profiles come from a JSON file (see foundry-servers.example.json):
 *   { "defaultServer": "forge",
 *     "servers": { "forge": { "label": "...", "port": 31415, ... } } }
 *
 * Discovery order:
 *   1. FOUNDRY_SERVERS_CONFIG env var (absolute path)
 *   2. foundry-servers.json next to the running server bundle
 *   3. foundry-servers.json in the working directory
 * With no file, a single "default" profile is synthesized from the
 * environment configuration — identical to previous behavior.
 */

export const ServerProfileSchema = z.object({
  label: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  namespace: z.string().optional(),
  reconnectAttempts: z.number().int().min(1).max(20).optional(),
  reconnectDelay: z.number().int().min(100).max(30000).optional(),
  connectionTimeout: z.number().int().min(1000).max(60000).optional(),
  connectionType: z.enum(['websocket', 'webrtc', 'auto']).optional(),
  protocol: z.enum(['ws', 'wss']).optional(),
  remoteMode: z.boolean().optional(),
  rejectUnauthorized: z.boolean().optional(),
  authToken: z.string().optional(),
});

export const ServersFileSchema = z.object({
  defaultServer: z.string().optional(),
  servers: z.record(z.string(), ServerProfileSchema),
});

export type ServerProfile = z.infer<typeof ServerProfileSchema>;

export interface RegisteredServer {
  name: string;
  label: string;
  foundryConfig: Config['foundry'];
  client: FoundryClient;
}

export interface ServerRegistryStatus {
  config: {
    path: string | null;
    exists: boolean;
    source: 'file' | 'environment';
  };
  activeServer: string;
  servers: Array<{
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
  }>;
}

export interface BufferedEvent {
  seq: number;
  server: string;
  receivedAt: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const EVENT_BUFFER_SIZE = 200;

interface PortOwner {
  profile: string;
  role: 'main' | 'webrtc-signaling';
}

function reserveProfilePorts(
  profileName: string,
  foundryConfig: Config['foundry'],
  usedPorts: Map<number, PortOwner>
): string | null {
  const requested: Array<{ port: number; role: PortOwner['role'] }> = [
    { port: foundryConfig.port, role: 'main' },
  ];
  if (foundryConfig.connectionType !== 'websocket') {
    requested.push({
      port: foundryConfig.port + 1,
      role: 'webrtc-signaling',
    });
  }

  if (
    foundryConfig.remoteMode &&
    (!foundryConfig.authToken || foundryConfig.authToken.trim().length < 16)
  ) {
    return `Server profile "${profileName}" enables remoteMode without an authToken of at least 16 characters`;
  }

  const localPorts = new Set<number>();
  for (const request of requested) {
    if (!Number.isInteger(request.port) || request.port < 1024 || request.port > 65535) {
      return `Server profile "${profileName}" ${request.role} port ${request.port} is outside the valid range 1024-65535`;
    }
    if (localPorts.has(request.port)) {
      return `Server profile "${profileName}" assigns port ${request.port} to both its main and WebRTC signaling listeners`;
    }
    localPorts.add(request.port);

    const owner = usedPorts.get(request.port);
    if (owner) {
      return `Server profile "${profileName}" ${request.role} port ${request.port} conflicts with "${owner.profile}" ${owner.role} port`;
    }
  }

  for (const request of requested) {
    usedPorts.set(request.port, { profile: profileName, role: request.role });
  }
  return null;
}

export class ServerRegistry {
  private servers = new Map<string, RegisteredServer>();
  private activeName: string;
  private configuredDefaultName: string;
  private logger: Logger;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private selectedConfigPath: string | null = null;
  private readonly configFileOverride: string | null;
  public readonly routingClient: RoutingFoundryClient;

  // Game-event ring buffer (all profiles share one sequence for simple cursors)
  private events: BufferedEvent[] = [];
  private eventSeq = 0;

  constructor(config: Config, logger: Logger, configFileOverride?: string) {
    this.logger = logger.child({ component: 'ServerRegistry' });
    this.configFileOverride = configFileOverride ? path.resolve(configFileOverride) : null;

    const file = this.loadServersFile(configFileOverride);
    const profiles: Record<string, ServerProfile> = file?.servers ?? {
      default: { label: 'Default (from environment)' },
    };

    const usedPorts = new Map<number, PortOwner>();
    for (const [name, profile] of Object.entries(profiles)) {
      const foundryConfig: Config['foundry'] = {
        ...config.foundry,
        ...Object.fromEntries(
          Object.entries(profile).filter(([key, v]) => key !== 'label' && v !== undefined)
        ),
      };

      const portConflict = reserveProfilePorts(name, foundryConfig, usedPorts);
      if (portConflict) {
        this.logger.error(`${portConflict} — skipping`);
        continue;
      }

      const server: RegisteredServer = {
        name,
        label: profile.label || name,
        foundryConfig,
        client: new FoundryClient(foundryConfig, logger.child({ server: name })),
      };
      server.client.setEventHandler(event => this.pushEvent(name, event));
      this.servers.set(name, server);
    }

    if (this.servers.size === 0) {
      throw new Error('No valid Foundry server profiles configured');
    }

    const requestedDefault = file?.defaultServer;
    if (requestedDefault && !this.servers.has(requestedDefault)) {
      this.logger.warn(
        `defaultServer "${requestedDefault}" is not a configured profile; falling back to first`
      );
    }
    this.activeName =
      requestedDefault && this.servers.has(requestedDefault)
        ? requestedDefault
        : this.servers.keys().next().value!;
    this.configuredDefaultName = this.activeName;

    this.routingClient = new RoutingFoundryClient(this, config.foundry, logger);

    this.logger.info('Server registry initialized', {
      servers: [...this.servers.keys()],
      active: this.activeName,
    });
  }

  private loadServersFile(configFileOverride?: string): z.infer<typeof ServersFileSchema> | null {
    const candidates: string[] = [];
    if (configFileOverride) candidates.push(configFileOverride);
    if (process.env.FOUNDRY_SERVERS_CONFIG) candidates.push(process.env.FOUNDRY_SERVERS_CONFIG);
    try {
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.join(moduleDir, 'foundry-servers.json'));
    } catch {
      // CJS bundle: import.meta.url unavailable — fall through to cwd candidate
    }
    candidates.push(path.join(process.cwd(), 'foundry-servers.json'));

    const visited = new Set<string>();
    let firstCandidate: string | null = null;
    for (const candidate of candidates) {
      const resolvedCandidate = path.resolve(candidate);
      firstCandidate ??= resolvedCandidate;
      if (visited.has(resolvedCandidate)) continue;
      visited.add(resolvedCandidate);
      if (!fs.existsSync(resolvedCandidate)) continue;

      try {
        const raw = JSON.parse(fs.readFileSync(resolvedCandidate, 'utf8'));
        const parsed = ServersFileSchema.parse(raw);
        this.selectedConfigPath = resolvedCandidate;
        this.logger.info('Loaded Foundry servers config', {
          path: resolvedCandidate,
          servers: Object.keys(parsed.servers),
        });
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to load servers config from ${resolvedCandidate}`, {
          error: message,
        });
        // An existing higher-priority config is authoritative. Treating a
        // malformed/partially-written file as "no file" would synthesize the
        // environment profile and tear down healthy named connections during
        // reload, violating the registry's transactional guarantee.
        throw new Error(`Invalid Foundry servers config at "${resolvedCandidate}": ${message}`);
      }
    }
    // Report the exact file a desktop editor should create when an explicit
    // override/environment path was configured, even before it exists.
    this.selectedConfigPath = firstCandidate;
    return null;
  }

  getConfigFilePath(): string | null {
    return this.selectedConfigPath;
  }

  getStatus(): ServerRegistryStatus {
    const servers = [...this.servers.values()].map(server => {
      const cached = server.client.getCachedCapabilities();
      return {
        name: server.name,
        label: server.label,
        host: server.foundryConfig.host,
        port: server.foundryConfig.port,
        connectionType: server.foundryConfig.connectionType,
        remoteMode: server.foundryConfig.remoteMode,
        active: server.name === this.activeName,
        connected: server.client.isConnected(),
        connectionInfo: server.client.getConnectionInfo(),
        cachedCapabilities: cached
          ? {
              moduleId: cached.moduleId,
              moduleVersion: cached.moduleVersion,
              foundryVersion: cached.foundryVersion,
              system: { id: cached.system.id, version: cached.system.version },
              world: { id: cached.world.id, title: cached.world.title },
            }
          : null,
      };
    });

    return {
      config: {
        path: this.selectedConfigPath,
        exists: this.selectedConfigPath !== null && fs.existsSync(this.selectedConfigPath),
        source:
          this.selectedConfigPath !== null && fs.existsSync(this.selectedConfigPath)
            ? 'file'
            : 'environment',
      },
      activeServer: this.activeName,
      servers,
    };
  }

  /** Populate caches independently of status polling; callers never await transport work. */
  refreshCapabilityCaches(): void {
    for (const server of this.servers.values()) {
      server.client.refreshCapabilitiesInBackground();
    }
  }

  list(): Array<{
    name: string;
    label: string;
    host: string;
    port: number;
    connectionType: string;
    remoteMode: boolean;
    active: boolean;
    connected: boolean;
    connectionInfo: unknown;
  }> {
    return [...this.servers.values()].map(s => ({
      name: s.name,
      label: s.label,
      host: s.foundryConfig.host,
      port: s.foundryConfig.port,
      connectionType: s.foundryConfig.connectionType,
      remoteMode: s.foundryConfig.remoteMode,
      active: s.name === this.activeName,
      connected: s.client.isConnected(),
      connectionInfo: s.client.getConnectionInfo(),
    }));
  }

  get(name: string): RegisteredServer | undefined {
    return this.servers.get(name);
  }

  getActive(): RegisteredServer {
    const contextName = serverContext.getStore();
    const name = contextName ?? this.activeName;
    const server = this.servers.get(name);
    if (!server) {
      const available = [...this.servers.keys()].join(', ');
      throw new Error(
        contextName
          ? `Unknown server "${contextName}" in per-call override. Available servers: ${available}`
          : `Active server "${name}" is not registered`
      );
    }
    return server;
  }

  getActiveName(): string {
    return this.activeName;
  }

  setActive(name: string): RegisteredServer {
    const server = this.servers.get(name);
    if (!server) {
      const available = [...this.servers.keys()].join(', ');
      throw new Error(`Unknown server "${name}". Available servers: ${available}`);
    }
    this.activeName = name;
    this.logger.info('Active Foundry server switched', { active: name });
    return server;
  }

  /** Start listeners for every profile; failures on one don't block others. */
  async connectAll(): Promise<void> {
    return this.runLifecycle(async () => {
      await this.connectAllInternal();
    });
  }

  private async connectAllInternal(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map(async server => {
        try {
          await server.client.connect();
        } catch (error) {
          this.logger.error(`Failed to start connector for server "${server.name}"`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
  }

  private pushEvent(serverName: string, event: any): void {
    this.events.push({
      seq: ++this.eventSeq,
      server: serverName,
      receivedAt: new Date().toISOString(),
      type: String(event?.type || 'unknown'),
      timestamp: String(event?.timestamp || ''),
      data: (event?.data as Record<string, unknown>) || {},
    });
    if (this.events.length > EVENT_BUFFER_SIZE) {
      this.events.splice(0, this.events.length - EVENT_BUFFER_SIZE);
    }
  }

  latestEventSeq(): number {
    return this.eventSeq;
  }

  getEventsSince(options: {
    sinceSeq?: number;
    types?: string[];
    server?: string;
    limit?: number;
  }): BufferedEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), EVENT_BUFFER_SIZE);
    const routedServer = options.server ?? serverContext.getStore() ?? this.activeName;
    return this.events
      .filter(
        event =>
          (!options.sinceSeq || event.seq > options.sinceSeq) &&
          (!options.types?.length || options.types.includes(event.type)) &&
          event.server === routedServer
      )
      .slice(-limit);
  }

  /** Restart the listener for one profile (module reconnects on its own). */
  async reconnect(name: string): Promise<RegisteredServer> {
    return this.runLifecycle(() => this.reconnectInternal(name));
  }

  private async reconnectInternal(name: string): Promise<RegisteredServer> {
    const server = this.servers.get(name);
    if (!server) {
      throw new Error(
        `Unknown server "${name}". Available servers: ${[...this.servers.keys()].join(', ')}`
      );
    }
    try {
      await server.client.disconnect();
    } catch {
      // already stopped
    }
    await server.client.connect();
    this.logger.info('Server connector restarted', { server: name });
    return server;
  }

  /**
   * Re-read the servers config file and apply the difference: new profiles
   * start, removed profiles stop, changed profiles restart. Unchanged
   * profiles keep their live connections.
   */
  async reloadConfig(
    config: Config,
    logger: Logger
  ): Promise<{ added: string[]; removed: string[]; changed: string[]; unchanged: string[] }> {
    return this.runLifecycle(() => this.reloadConfigInternal(config, logger));
  }

  private async reloadConfigInternal(
    config: Config,
    logger: Logger
  ): Promise<{ added: string[]; removed: string[]; changed: string[]; unchanged: string[] }> {
    // Keep reloading the same authoritative path selected at startup. This is
    // essential for desktop editing and also fixes constructor overrides being
    // forgotten after the initial load.
    const preferredPath = this.configFileOverride ?? this.selectedConfigPath ?? undefined;
    const file = this.loadServersFile(preferredPath);
    const profiles: Record<string, ServerProfile> = file?.servers ?? {
      default: { label: 'Default (from environment)' },
    };

    // Resolve and validate the complete listener plan before changing any
    // live profile. This makes a bad reload transactional instead of tearing
    // down healthy connections and then failing halfway through a rebind.
    const plannedProfiles = new Map<
      string,
      { profile: ServerProfile; foundryConfig: Config['foundry'] }
    >();
    const usedPorts = new Map<number, PortOwner>();
    for (const [name, profile] of Object.entries(profiles)) {
      const foundryConfig: Config['foundry'] = {
        ...config.foundry,
        ...Object.fromEntries(
          Object.entries(profile).filter(([key, v]) => key !== 'label' && v !== undefined)
        ),
      };
      const conflict = reserveProfilePorts(name, foundryConfig, usedPorts);
      if (conflict) throw new Error(conflict);
      plannedProfiles.set(name, { profile, foundryConfig });
    }
    if (plannedProfiles.size === 0) throw new Error('No valid Foundry server profiles configured');

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const [name, existing] of this.servers) {
      const planned = plannedProfiles.get(name);
      if (!planned) removed.push(name);
      else if (JSON.stringify(existing.foundryConfig) === JSON.stringify(planned.foundryConfig)) {
        unchanged.push(name);
      } else {
        changed.push(name);
      }
    }
    for (const name of plannedProfiles.keys()) {
      if (!this.servers.has(name)) added.push(name);
    }

    const stoppedExisting: RegisteredServer[] = [];
    const staged = new Map<string, RegisteredServer>();
    const priorActiveName = this.activeName;
    const priorConfiguredDefaultName = this.configuredDefaultName;
    const wasFollowingConfiguredDefault = priorActiveName === priorConfiguredDefaultName;

    try {
      // Changed listeners may retain the same port, and new profiles may take
      // a removed profile's port. Stop only profiles that cannot survive the
      // transaction; unchanged live connections remain untouched.
      for (const name of [...removed, ...changed]) {
        const existing = this.servers.get(name);
        if (!existing) continue;
        stoppedExisting.push(existing);
        await existing.client.disconnect();
      }

      // Every replacement must bind successfully before the registry map is
      // committed. A failed start rolls all stopped profiles back below.
      for (const name of [...added, ...changed]) {
        const planned = plannedProfiles.get(name)!;
        const server: RegisteredServer = {
          name,
          label: planned.profile.label || name,
          foundryConfig: planned.foundryConfig,
          client: new FoundryClient(planned.foundryConfig, logger.child({ server: name })),
        };
        server.client.setEventHandler(event => this.pushEvent(name, event));
        staged.set(name, server);
        await server.client.connect();
      }
    } catch (error) {
      for (const server of staged.values()) {
        try {
          await server.client.disconnect();
        } catch {
          // Best effort; continue restoring the known-good profiles.
        }
      }

      const rollbackErrors: string[] = [];
      for (const server of stoppedExisting) {
        try {
          await server.client.connect();
        } catch (rollbackError) {
          rollbackErrors.push(
            `${server.name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      this.activeName = priorActiveName;

      const originalMessage = error instanceof Error ? error.message : String(error);
      const rollbackSuffix = rollbackErrors.length
        ? ` Rollback also failed for ${rollbackErrors.join('; ')}`
        : '';
      throw new Error(`Server config reload failed: ${originalMessage}.${rollbackSuffix}`);
    }

    // Commit only after all staged connectors are listening.
    for (const name of [...removed, ...changed]) this.servers.delete(name);
    for (const [name, server] of staged) this.servers.set(name, server);
    for (const name of unchanged) {
      const planned = plannedProfiles.get(name)!;
      this.servers.get(name)!.label = planned.profile.label || name;
    }

    const nextConfiguredDefaultName =
      file?.defaultServer && this.servers.has(file.defaultServer)
        ? file.defaultServer
        : this.servers.keys().next().value!;

    // Keep a valid active server. An explicit default-only config change is
    // honored when the registry was still following the prior default, but
    // does not clobber a deliberate manual selection of a different profile.
    if (!this.servers.has(this.activeName)) {
      this.activeName = nextConfiguredDefaultName;
    } else if (
      nextConfiguredDefaultName !== priorConfiguredDefaultName &&
      wasFollowingConfiguredDefault
    ) {
      this.activeName = nextConfiguredDefaultName;
    }
    this.configuredDefaultName = nextConfiguredDefaultName;

    this.logger.info('Servers config reloaded', {
      added,
      removed,
      changed,
      unchanged,
      active: this.activeName,
    });
    return { added, removed, changed, unchanged };
  }

  async disconnectAll(): Promise<void> {
    return this.runLifecycle(async () => {
      await Promise.all(
        [...this.servers.values()].map(async server => {
          try {
            await server.client.disconnect();
          } catch {
            // best effort
          }
        })
      );
    });
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * FoundryClient facade that forwards every call to the active profile's
 * client. Extends FoundryClient only for type compatibility with existing
 * tool constructors; the inherited connector is never started.
 */
export class RoutingFoundryClient extends FoundryClient {
  private registry: ServerRegistry;

  constructor(registry: ServerRegistry, baseFoundryConfig: Config['foundry'], logger: Logger) {
    super(baseFoundryConfig, logger.child({ component: 'RoutingFoundryClient' }));
    this.registry = registry;
  }

  override async connect(): Promise<void> {
    return this.registry.getActive().client.connect();
  }

  override async disconnect(): Promise<void> {
    await this.registry.getActive().client.disconnect();
  }

  override getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.registry.getActive().client.getConnectionType();
  }

  override async query(method: string, data?: any): Promise<any> {
    return this.registry.getActive().client.query(method, data);
  }

  override ping(): Promise<any> {
    return this.registry.getActive().client.ping();
  }

  override getConnectionInfo(): any {
    return this.registry.getActive().client.getConnectionInfo();
  }

  override getConnectionState(): string {
    return this.registry.getActive().client.getConnectionState();
  }

  override isReady(): boolean {
    return this.registry.getActive().client.isReady();
  }

  override async sendMessage(message: any): Promise<void> {
    await this.registry.getActive().client.sendMessage(message);
  }

  override async broadcastMessage(message: any): Promise<void> {
    await this.registry.getActive().client.broadcastMessage(message);
  }

  override isConnected(): boolean {
    return this.registry.getActive().client.isConnected();
  }

  override getCapabilities(force = false): Promise<any> {
    return this.registry.getActive().client.getCapabilities(force);
  }
}
