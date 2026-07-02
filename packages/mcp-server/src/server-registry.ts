import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';
import { Config } from './config.js';
import { FoundryClient } from './foundry-client.js';

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

const ServerProfileSchema = z.object({
  label: z.string().optional(),
  host: z.string().optional(),
  port: z.number().min(1024).max(65535).optional(),
  namespace: z.string().optional(),
  reconnectAttempts: z.number().min(1).max(20).optional(),
  reconnectDelay: z.number().min(100).max(30000).optional(),
  connectionTimeout: z.number().min(1000).max(60000).optional(),
  connectionType: z.enum(['websocket', 'webrtc', 'auto']).optional(),
  protocol: z.enum(['ws', 'wss']).optional(),
  remoteMode: z.boolean().optional(),
  dataPath: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
  webrtcSignalingPort: z.number().min(1024).max(65535).optional(),
});

const ServersFileSchema = z.object({
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

export class ServerRegistry {
  private servers = new Map<string, RegisteredServer>();
  private activeName: string;
  private logger: Logger;
  public readonly routingClient: RoutingFoundryClient;

  constructor(config: Config, logger: Logger, configFileOverride?: string) {
    this.logger = logger.child({ component: 'ServerRegistry' });

    const file = this.loadServersFile(configFileOverride);
    const profiles: Record<string, ServerProfile> = file?.servers ?? {
      default: { label: 'Default (from environment)' },
    };

    const usedPorts = new Map<number, string>();
    for (const [name, profile] of Object.entries(profiles)) {
      const foundryConfig: Config['foundry'] = {
        ...config.foundry,
        ...Object.fromEntries(
          Object.entries(profile).filter(([key, v]) => key !== 'label' && v !== undefined)
        ),
      };

      const portOwner = usedPorts.get(foundryConfig.port);
      if (portOwner) {
        this.logger.error(
          `Server profile "${name}" reuses port ${foundryConfig.port} already taken by "${portOwner}" — skipping`
        );
        continue;
      }
      usedPorts.set(foundryConfig.port, name);

      this.servers.set(name, {
        name,
        label: profile.label || name,
        foundryConfig,
        client: new FoundryClient(foundryConfig, logger.child({ server: name })),
      });
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

    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        const parsed = ServersFileSchema.parse(raw);
        this.logger.info('Loaded Foundry servers config', {
          path: candidate,
          servers: Object.keys(parsed.servers),
        });
        return parsed;
      } catch (error) {
        this.logger.error(`Failed to load servers config from ${candidate}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
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
    const server = this.servers.get(this.activeName);
    if (!server) {
      throw new Error(`Active server "${this.activeName}" is not registered`);
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

  disconnectAll(): void {
    for (const server of this.servers.values()) {
      try {
        server.client.disconnect();
      } catch {
        // best effort
      }
    }
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

  override disconnect(): void {
    this.registry.getActive().client.disconnect();
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

  override sendMessage(message: any): void {
    this.registry.getActive().client.sendMessage(message);
  }

  override broadcastMessage(message: any): void {
    this.registry.getActive().client.broadcastMessage(message);
  }

  override isConnected(): boolean {
    return this.registry.getActive().client.isConnected();
  }
}
