import { Logger } from './logger.js';
import { Config } from './config.js';
import { FoundryConnector } from './foundry-connector.js';

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

export class FoundryClient {
  private logger: Logger;
  private config: Config['foundry'];
  private connector: FoundryConnector;
  private capabilities: ModuleCapabilities | null = null;
  private listenerStartedAt = 0;

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

    try {
      // Start the socket.io server that Foundry will connect to
      await this.connector.start();
      this.listenerStartedAt = Date.now();
      this.logger.info('Foundry connector started, waiting for module connection...');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      this.logger.error('Failed to start Foundry connector', { error: errorMessage });
      throw new Error(`Failed to start Foundry connector: ${errorMessage}`);
    }
  }

  disconnect(): void {
    this.logger.info('Stopping Foundry connector...');
    this.connector.stop().catch(error => {
      this.logger.error('Error stopping connector', error);
    });
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.connector.getConnectionType();
  }

  async query(method: string, data?: any): Promise<any> {
    if (!this.connector.isConnected()) {
      // Startup grace: a freshly (re)started backend races the Foundry
      // module's ~30s reconnect cadence. Instead of failing the user's first
      // prompt, wait for the module to come back.
      // listenerStartedAt === 0 means the listener is still starting — that
      // is the earliest (and raciest) moment, so it is always within grace.
      const withinGrace = !this.listenerStartedAt || Date.now() - this.listenerStartedAt < 90_000;
      if (withinGrace) {
        this.logger.info('Module not connected yet; waiting for reconnect (startup grace)', {
          method,
        });
        const deadline = Date.now() + 45_000;
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
      throw await this.classifyQueryError(method, errorMessage);
    }
  }

  /**
   * Turn raw query failures into coded errors. "No handler found" almost
   * always means the installed module predates this server — say so, with the
   * module version when we can discover it.
   */
  private async classifyQueryError(method: string, errorMessage: string): Promise<Error> {
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
    if (/timeout/i.test(errorMessage)) {
      return new BridgeError('TIMEOUT', `Query ${method} timed out: ${errorMessage}`);
    }
    return new BridgeError('QUERY_FAILED', `Query ${method} failed: ${errorMessage}`);
  }

  /**
   * Module capabilities (version + supported handlers), cached until
   * disconnect. Returns null when the module predates getCapabilities.
   */
  async getCapabilities(force = false): Promise<ModuleCapabilities | null> {
    if (!this.connector.isConnected()) {
      this.capabilities = null;
      return null;
    }
    if (this.capabilities && !force) return this.capabilities;
    try {
      const result = await this.connector.query('foundry-mcp-bridge.getCapabilities', {});
      if (result?.moduleVersion) {
        this.capabilities = result as ModuleCapabilities;
        return this.capabilities;
      }
      return null;
    } catch {
      return null; // old module without the handler
    }
  }

  ping(): Promise<any> {
    return this.query('foundry-mcp-bridge.ping');
  }

  getConnectionInfo(): any {
    return this.connector.getConnectionInfo();
  }

  getConnectionState(): string {
    return this.connector.isConnected() ? 'connected' : 'disconnected';
  }

  isReady(): boolean {
    return this.connector.isConnected();
  }

  sendMessage(message: any): void {
    this.logger.debug('Sending message to Foundry', {
      type: message.type,
      requestId: message.requestId,
    });
    this.connector.sendToFoundry(message);
  }

  broadcastMessage(message: any): void {
    this.logger.debug('Broadcasting message to Foundry', { type: message.type });
    this.connector.broadcastMessage(message);
  }

  isConnected(): boolean {
    return this.connector.isConnected();
  }
}
