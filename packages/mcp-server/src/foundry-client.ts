import { Logger } from './logger.js';
import { Config } from './config.js';
import {
  FoundryConnector,
  QueryOutcomeUnknownError,
  QueryTimeoutError,
} from './foundry-connector.js';

export interface FoundryQuery {
  method: string;
  data?: any;
}

export interface FoundryResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export type BridgeErrorCode =
  | 'NOT_CONNECTED'
  | 'NO_HANDLER'
  | 'VERSION_MISMATCH'
  | 'TIMEOUT'
  | 'UNKNOWN_OUTCOME'
  | 'QUERY_FAILED';

/** Error with a machine-readable code so agents can branch on failure class. */
export class BridgeError extends Error {
  constructor(
    public code: BridgeErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BridgeError';
  }
}

export interface ModuleCapabilities {
  moduleId: string;
  moduleVersion: string;
  foundryVersion: string;
  system: { id: string; version: string };
  world: { id: string; title: string };
  handlers: string[];
}

export interface ListenerErrorInfo {
  message: string;
  at: number;
}

export class FoundryClient {
  private logger: Logger;
  private config: Config['foundry'];
  private connector: FoundryConnector;
  private capabilities: ModuleCapabilities | null = null;
  private capabilitiesGeneration: number | null = null;
  private capabilitiesRequest: Promise<ModuleCapabilities | null> | null = null;
  private listenerStartedAt: number | null = null;
  private listenerStarting = false;
  private lastListenerError: ListenerErrorInfo | null = null;

  constructor(config: Config['foundry'], logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'FoundryClient' });

    // Initialize the socket connector
    this.connector = new FoundryConnector({
      config: this.config,
      logger: this.logger,
    });
  }

  async connect(): Promise<void> {
    this.logger.info('Starting Foundry connector socket.io server');
    this.listenerStarting = true;

    try {
      // Start the socket.io server that Foundry will connect to
      await this.connector.start();
      this.listenerStartedAt = Date.now();
      this.lastListenerError = null;
      this.logger.info('Foundry connector started, waiting for module connection...');
    } catch (error) {
      this.listenerStartedAt = null;
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      this.lastListenerError = { message: errorMessage, at: Date.now() };
      this.logger.error('Failed to start Foundry connector', { error: errorMessage });
      throw new Error(`Failed to start Foundry connector: ${errorMessage}`);
    } finally {
      this.listenerStarting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Stopping Foundry connector...');
    try {
      await this.connector.stop();
    } catch (error) {
      this.logger.error('Error stopping connector', error);
      throw error;
    } finally {
      this.listenerStartedAt = null;
      this.capabilities = null;
      this.capabilitiesGeneration = null;
      this.capabilitiesRequest = null;
    }
  }

  /** Receive unsolicited game events pushed by the module. */
  setEventHandler(handler: ((event: any) => void) | null): void {
    this.connector.onBridgeEvent = handler;
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.connector.getConnectionType();
  }

  async query(method: string, data?: any): Promise<any> {
    if (!this.connector.isConnected()) {
      // Startup grace: a freshly (re)started backend races the Foundry
      // module's ~30s reconnect cadence. Instead of failing the user's first
      // prompt, wait for the module to come back.
      const withinStartupGrace =
        this.listenerStarting ||
        (this.listenerStartedAt !== null && Date.now() - this.listenerStartedAt < 90_000);
      const lastDisconnectedAt = this.connector.getLastDisconnectAt();
      const withinRecentDisconnectGrace =
        lastDisconnectedAt !== null && Date.now() - lastDisconnectedAt < 90_000;
      if (withinStartupGrace || withinRecentDisconnectGrace) {
        this.logger.info('Module not connected yet; waiting for bounded reconnect grace', {
          method,
          reason: withinStartupGrace ? 'startup' : 'recent-disconnect',
        });
        const deadline = Date.now() + (withinStartupGrace ? 45_000 : 30_000);
        while (Date.now() < deadline && !this.connector.isConnected()) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (this.connector.isConnected()) {
          this.logger.info('Module reconnected during startup grace');
        }
      }
    }

    if (!this.connector.isConnected()) {
      this.capabilities = null;
      this.capabilitiesGeneration = null;
      throw new BridgeError(
        'NOT_CONNECTED',
        'Foundry VTT module not connected. Please ensure Foundry is running and the MCP Bridge module is enabled.'
      );
    }

    this.logger.debug('Sending query to Foundry module', { method, data });

    try {
      const result = await this.connector.query(method, data);
      this.logger.debug('Query successful', { method, hasResult: !!result });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown query error';
      this.logger.error('Query failed', { method, error: errorMessage });
      throw await this.classifyQueryError(method, error);
    }
  }

  /**
   * Turn raw query failures into coded errors. "No handler found" almost
   * always means the installed module predates this server — say so, with the
   * module version when we can discover it.
   */
  private async classifyQueryError(method: string, error: unknown): Promise<Error> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown query error';
    if (/No handler found/i.test(errorMessage)) {
      const caps = await this.getCapabilities().catch(() => null);
      if (caps) {
        return new BridgeError(
          'VERSION_MISMATCH',
          `The connected Foundry module (v${caps.moduleVersion}, world "${caps.world?.title}") does not support "${method}". ` +
            `Update the Foundry MCP Bridge module to match this MCP server, then reload the world.`
        );
      }
      return new BridgeError(
        'NO_HANDLER',
        `The connected Foundry module does not support "${method}" — it likely predates this MCP server. Update the module and reload the world.`
      );
    }
    if (
      (error instanceof QueryTimeoutError || error instanceof QueryOutcomeUnknownError) &&
      !this.isReadOnlyMethod(method)
    ) {
      return new BridgeError(
        'UNKNOWN_OUTCOME',
        `The response to ${method} was lost after it may have reached Foundry. It may have completed; inspect current state before retrying the write.`
      );
    }
    if (error instanceof QueryTimeoutError || /timeout/i.test(errorMessage)) {
      return new BridgeError('TIMEOUT', `Query ${method} timed out: ${errorMessage}`);
    }
    return new BridgeError('QUERY_FAILED', `Query ${method} failed: ${errorMessage}`);
  }

  private isReadOnlyMethod(method: string): boolean {
    const operation = method.split('.').pop() || method;
    return /^(get|list|search|find|browse|check|validate|resolve|preview|ping|inspect|read|query|wait|audit)/i.test(
      operation
    );
  }

  /**
   * Module capabilities (version + supported handlers), cached until
   * disconnect. Returns null when the module predates getCapabilities.
   */
  async getCapabilities(force = false): Promise<ModuleCapabilities | null> {
    if (!this.connector.isConnected()) {
      this.capabilities = null;
      this.capabilitiesGeneration = null;
      this.capabilitiesRequest = null;
      return null;
    }
    const connectionGeneration = this.connector.getConnectionGeneration();
    if (this.capabilities && this.capabilitiesGeneration === connectionGeneration && !force) {
      return this.capabilities;
    }
    if (this.capabilitiesRequest && !force) return this.capabilitiesRequest;

    const request = (async (): Promise<ModuleCapabilities | null> => {
      try {
        const result = await this.connector.query('foundry-mcp-bridge.getCapabilities', {});
        if (result?.moduleVersion) {
          // Never attach world A's response to a replacement transport for B.
          if (this.connector.getConnectionGeneration() !== connectionGeneration) return null;
          this.capabilities = result as ModuleCapabilities;
          this.capabilitiesGeneration = connectionGeneration;
          return this.capabilities;
        }
        return null;
      } catch {
        return null; // old module without the handler
      }
    })();
    this.capabilitiesRequest = request;
    try {
      return await request;
    } finally {
      if (this.capabilitiesRequest === request) this.capabilitiesRequest = null;
    }
  }

  /** Read the current connection's cache without ever sending a transport query. */
  getCachedCapabilities(): ModuleCapabilities | null {
    if (!this.connector.isConnected()) return null;
    if (this.capabilitiesGeneration !== this.connector.getConnectionGeneration()) return null;
    return this.capabilities;
  }

  /** Start one best-effort cache fill while allowing status callers to return immediately. */
  refreshCapabilitiesInBackground(): void {
    if (!this.connector.isConnected() || this.getCachedCapabilities() || this.capabilitiesRequest) {
      return;
    }
    void this.getCapabilities().catch(() => null);
  }

  ping(): Promise<any> {
    return this.query('foundry-mcp-bridge.ping');
  }

  getConnectionInfo(): any {
    return {
      ...this.connector.getConnectionInfo(),
      listener: {
        starting: this.listenerStarting,
        startedAt: this.listenerStartedAt,
        lastError: this.lastListenerError,
      },
    };
  }

  getConnectionState(): string {
    return this.connector.isConnected() ? 'connected' : 'disconnected';
  }

  isReady(): boolean {
    return this.connector.isConnected();
  }

  async sendMessage(message: any): Promise<void> {
    this.logger.debug('Sending message to Foundry', {
      type: message.type,
      requestId: message.requestId,
    });
    await this.connector.sendToFoundry(message);
  }

  async broadcastMessage(message: any): Promise<void> {
    this.logger.debug('Broadcasting message to Foundry', { type: message.type });
    await this.connector.broadcastMessage(message);
  }

  isConnected(): boolean {
    return this.connector.isConnected();
  }
}
