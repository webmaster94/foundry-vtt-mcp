import { MODULE_ID, CONNECTION_STATES } from './constants.js';
import { WebRTCConnection, type WebRTCConfig } from './webrtc-connection.js';

export interface BridgeConfig {
  enabled: boolean;
  serverHost: string;
  serverPort: number;
  namespace: string;
  reconnectAttempts: number;
  reconnectDelay: number;
  connectionTimeout: number;
  debugLogging: boolean;
  connectionType?: 'auto' | 'webrtc' | 'websocket'; // Connection type: auto (HTTPS→WebRTC, HTTP→WebSocket), webrtc, websocket
  /** Optional shared secret; must match the MCP server profile's authToken. */
  authToken?: string;
  /** Whether a live bridge should reconnect after transport loss. */
  autoReconnect?: boolean;
}

export interface SocketBridgeActivityCallbacks {
  /** Called immediately before an inbound MCP query begins executing. */
  onQueryStart?: () => unknown;
  /** Called after the query response has been sent, including failure responses. */
  onQueryEnd?: (activityToken: unknown) => void;
  /** Called whenever the transport becomes usable, including after a reconnect. */
  onConnected?: () => void;
  /** Called whenever the transport stops being usable. */
  onDisconnected?: () => void;
}

/**
 * Browser-compatible socket bridge that supports both WebSocket and WebRTC
 */
export class SocketBridge {
  private ws: WebSocket | null = null;
  private webrtc: WebRTCConnection | null = null;
  private connectionState: string = CONNECTION_STATES.DISCONNECTED;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: any = null;
  private activeConnectionType: 'websocket' | 'webrtc' | null = null;
  private disposed = false;
  private pendingConnectReject: ((error: Error) => void) | null = null;
  private standbyBecauseOwnerActive = false;

  constructor(
    private config: BridgeConfig,
    private activityCallbacks: SocketBridgeActivityCallbacks = {}
  ) {
    this.maxReconnectAttempts = config.reconnectAttempts;
  }

  /** Refresh a passive retry owner's settings without replacing the bridge. */
  updateConfig(config: BridgeConfig): void {
    const changed =
      this.config.serverHost !== config.serverHost ||
      this.config.serverPort !== config.serverPort ||
      this.config.namespace !== config.namespace ||
      this.config.connectionType !== config.connectionType ||
      this.config.authToken !== config.authToken ||
      this.config.autoReconnect !== config.autoReconnect ||
      this.config.reconnectAttempts !== config.reconnectAttempts ||
      this.config.reconnectDelay !== config.reconnectDelay ||
      this.config.connectionTimeout !== config.connectionTimeout;

    this.config = config;
    this.maxReconnectAttempts = config.reconnectAttempts;

    if (config.autoReconnect === false) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (!this.isTransportReady()) this.connectionState = CONNECTION_STATES.DISCONNECTED;
      return;
    }

    if (
      !changed ||
      this.disposed ||
      this.isTransportReady() ||
      this.connectionState === CONNECTION_STATES.CONNECTING
    ) {
      return;
    }

    // Preserve an existing standby cadence. Replacing its timer with a fast
    // retry while the active GM restarts could make the standby race for
    // ownership; the pending attempt will read this updated config.
    if (!this.reconnectTimer) this.scheduleReconnect();
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Socket bridge has been disposed');
    }
    if (
      this.connectionState === CONNECTION_STATES.CONNECTED ||
      this.connectionState === CONNECTION_STATES.CONNECTING
    ) {
      return;
    }

    // Determine connection type
    const connectionType = this.determineConnectionType();
    this.connectionState = CONNECTION_STATES.CONNECTING;
    this.log('Connecting to MCP server...');
    this.log(`Using connection type: ${connectionType}`);

    if (connectionType === 'webrtc') {
      await this.connectWebRTC();
    } else {
      await this.connectWebSocket();
    }
  }

  private determineConnectionType(): 'websocket' | 'webrtc' {
    const configType = this.config.connectionType || 'auto';
    let connectionType: 'websocket' | 'webrtc';

    if (configType === 'auto') {
      // Use WebRTC for HTTPS (secure), WebSocket for HTTP (localhost)
      // WebRTC provides P2P encrypted channel without needing SSL certificates
      const isHttps = window.location.protocol === 'https:';
      connectionType = isHttps ? 'webrtc' : 'websocket';
      this.log(
        `Auto-detected connection type: ${connectionType} (page is ${window.location.protocol})`
      );
    } else {
      connectionType = configType as 'websocket' | 'webrtc';
    }

    if (
      connectionType === 'websocket' &&
      window.location.protocol === 'https:' &&
      this.isLoopbackHost(this.config.serverHost)
    ) {
      // The bundled daemon is a cleartext loopback listener. Browsers forbid
      // ws:// from an HTTPS world, while wss:// cannot speak to that listener
      // without a separate TLS reverse proxy. Do not silently change an
      // explicit transport choice; guide the GM to the compatible option.
      throw new Error(
        'WebSocket cannot reach the bundled cleartext loopback bridge from an HTTPS Foundry page; select Auto or WebRTC'
      );
    }

    if ((configType === 'auto' || connectionType === 'webrtc') && this.config.serverPort > 65534) {
      throw new Error(
        'Auto/WebRTC serverPort must be at most 65534 because signaling uses the next port'
      );
    }

    return connectionType;
  }

  private isLoopbackHost(host: string): boolean {
    const normalized = host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  }

  private async connectWebRTC(): Promise<void> {
    this.activeConnectionType = 'webrtc';

    const webrtcConfig: WebRTCConfig = {
      serverHost: this.config.serverHost,
      serverPort: this.config.serverPort,
      namespace: this.config.namespace,
      stunServers: [], // Empty for localhost - must match server configuration
      connectionTimeout: this.config.connectionTimeout,
      debugLogging: this.config.debugLogging,
      ...(this.config.authToken ? { authToken: this.config.authToken } : {}),
    };

    const connection = new WebRTCConnection(webrtcConfig, connected => {
      if (this.disposed || this.activeConnectionType !== 'webrtc' || this.webrtc !== connection)
        return;

      const wasConnected = this.connectionState === CONNECTION_STATES.CONNECTED;
      this.connectionState = connected
        ? CONNECTION_STATES.CONNECTED
        : CONNECTION_STATES.DISCONNECTED;

      if (connected) {
        this.standbyBecauseOwnerActive = false;
        this.reconnectAttempts = 0;
        if (!wasConnected) this.notifyConnectionState(true);
      } else {
        if (wasConnected) this.notifyConnectionState(false);
        this.webrtc = null;
        connection.disconnect();
        this.scheduleReconnect();
      }
    });
    this.webrtc = connection;

    try {
      await connection.connect(this.handleMessage.bind(this));
      await connection.waitUntilConnected();
      if (this.webrtc !== connection) throw new Error('WebRTC connection was superseded');
      if (this.disposed) throw new Error('Socket bridge has been disposed');
      this.log('Connected via WebRTC');
    } catch (error) {
      this.log(`WebRTC connection failed: ${error}`);
      if (/Another Foundry module connection is active|HTTP 409/i.test(String(error))) {
        this.standbyBecauseOwnerActive = true;
      }
      if (this.webrtc === connection) {
        this.webrtc = null;
        connection.disconnect();
        this.connectionState = CONNECTION_STATES.DISCONNECTED;
        this.notifyConnectionState(false);
        if (!this.disposed) this.scheduleReconnect();
      }
      throw error;
    }
  }

  private async connectWebSocket(): Promise<void> {
    this.activeConnectionType = 'websocket';

    // Match the page's transport security. Browsers reject ws:// from an
    // HTTPS world as mixed content, including Forge-hosted worlds.
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = this.config.serverHost;
    this.log(`Using WebSocket (${protocol}://${host}:${this.config.serverPort})`);

    const wsUrl = `${protocol}://${host}:${this.config.serverPort}${this.config.namespace}${
      this.config.authToken ? `?token=${encodeURIComponent(this.config.authToken)}` : ''
    }`;

    return new Promise((resolve, reject) => {
      let socket: WebSocket | null = null;
      let settled = false;
      const resolveConnect = (): void => {
        if (settled) return;
        settled = true;
        if (this.pendingConnectReject === rejectConnect) this.pendingConnectReject = null;
        resolve();
      };
      const rejectConnect = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (this.pendingConnectReject === rejectConnect) this.pendingConnectReject = null;
        reject(error);
      };
      this.pendingConnectReject = rejectConnect;

      const connectTimeout = setTimeout(() => {
        if (this.disposed) {
          rejectConnect(new Error('Socket bridge has been disposed'));
          return;
        }
        if (socket && this.ws !== socket) {
          rejectConnect(new Error('WebSocket connection was superseded'));
          return;
        }
        this.log('Connection timeout');
        if (socket) {
          socket.onopen = null;
          socket.onerror = null;
          socket.onclose = null;
          socket.onmessage = null;
          socket.close();
          if (this.ws === socket) this.ws = null;
        }
        this.connectionState = CONNECTION_STATES.DISCONNECTED;
        this.notifyConnectionState(false);
        this.scheduleReconnect();
        rejectConnect(new Error('Connection timeout'));
      }, this.config.connectionTimeout * 1000);

      try {
        socket = new WebSocket(wsUrl);
        this.ws = socket;

        socket.onopen = () => {
          clearTimeout(connectTimeout);
          if (this.disposed || this.ws !== socket) {
            socket?.close();
            rejectConnect(new Error('Socket bridge has been disposed'));
            return;
          }
          this.connectionState = CONNECTION_STATES.CONNECTED;
          this.notifyConnectionState(true);
          this.log('Connected to MCP server via WebSocket');
          this.setupEventHandlers();
          resolveConnect();
        };

        socket.onerror = error => {
          clearTimeout(connectTimeout);
          if (this.ws !== socket) return;
          if (this.disposed) {
            rejectConnect(new Error('Socket bridge has been disposed'));
            return;
          }
          // Use more informative message for connection failures
          const isFirstAttempt = this.reconnectAttempts === 0;
          const errorMsg = isFirstAttempt
            ? "MCP server not available (this is normal if server isn't running)"
            : `Connection error after ${this.reconnectAttempts} attempts: ${error}`;
          this.log(errorMsg);
          this.ws = null;
          socket!.onopen = null;
          socket!.onerror = null;
          socket!.onclose = null;
          socket!.onmessage = null;
          socket!.close();
          this.connectionState = CONNECTION_STATES.DISCONNECTED;
          this.notifyConnectionState(false);
          this.scheduleReconnect();
          rejectConnect(new Error('WebSocket connection failed'));
        };

        socket.onclose = event => {
          clearTimeout(connectTimeout);
          if (this.ws !== socket) return;
          this.ws = null;
          if (this.disposed) return;
          this.log(`Disconnected: ${event.reason || 'Connection closed'}`);
          if (
            event.code === 4009 ||
            /Another Foundry module connection is active/i.test(event.reason)
          ) {
            this.standbyBecauseOwnerActive = true;
          }
          this.connectionState = CONNECTION_STATES.DISCONNECTED;
          this.notifyConnectionState(false);
          rejectConnect(new Error('WebSocket closed'));

          // Remote clean closes (for example, a graceful backend restart) still
          // need to self-heal. Manual closes mark the bridge disposed above.
          this.scheduleReconnect();
        };
      } catch (error) {
        clearTimeout(connectTimeout);
        this.log(`Failed to create WebSocket: ${error}`);
        this.connectionState = CONNECTION_STATES.DISCONNECTED;
        this.notifyConnectionState(false);
        rejectConnect(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingConnectReject?.(new Error('Socket bridge has been disposed'));
    this.pendingConnectReject = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.webrtc) {
      const webrtc = this.webrtc;
      this.webrtc = null;
      webrtc.disconnect();
    }

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(1000, 'Manual disconnect');
    }

    this.activeConnectionType = null;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.notifyConnectionState(false);
    this.log('Disconnected from MCP server');
  }

  /**
   * Bring a throttled/backgrounded tab back into the retry loop immediately.
   * This keeps a single SocketBridge as the reconnect owner while avoiding an
   * additional long-lived timer or replacement bridge.
   */
  async reconnectNow(): Promise<void> {
    if (this.disposed || this.config.autoReconnect === false) return;

    if (this.isTransportReady()) {
      return;
    }

    if (this.connectionState === CONNECTION_STATES.CONNECTED) {
      this.handleTransportFailure();
    }

    if (this.connectionState === CONNECTION_STATES.CONNECTING) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    await this.connect();
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        // Only an application-level response proves the connection was
        // accepted by the backend. A duplicate socket can open and then be
        // immediately closed with code 4009, so resetting on `open` creates a
        // one-second two-tab retry loop.
        this.reconnectAttempts = 0;
        this.standbyBecauseOwnerActive = false;
        this.handleMessage(message);
      } catch (error) {
        this.log(`Failed to parse message: ${error}`);
      }
    };
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      if (message.type === 'mcp-query') {
        const tracksActivity = ![
          `${MODULE_ID}.getBrowserConsoleStatus`,
          `${MODULE_ID}.ping`,
        ].includes(message.data?.method);
        const activityToken = tracksActivity ? this.notifyActivityStart() : undefined;
        try {
          await this.handleMCPQuery(message.data, response =>
            this.sendMessage({
              type: 'mcp-response',
              id: message.id,
              data: response,
            })
          );
        } finally {
          if (tracksActivity) this.notifyActivityEnd(activityToken);
        }
      } else if (message.type === 'ping') {
        await this.sendMessage({
          type: 'pong',
          id: message.id,
          data: { timestamp: Date.now(), status: 'ok' },
        });
      }
    } catch (error) {
      console.error(`[foundry-mcp-bridge] ERROR in handleMessage:`, error);
      this.log(`Error handling message: ${error}`);
    }
  }

  private notifyActivityStart(): unknown {
    try {
      return this.activityCallbacks.onQueryStart?.();
    } catch (error) {
      // Performance diagnostics must never interfere with MCP query handling.
      this.log(`Query activity callback failed: ${error}`);
      return undefined;
    }
  }

  private notifyActivityEnd(activityToken: unknown): void {
    try {
      this.activityCallbacks.onQueryEnd?.(activityToken);
    } catch (error) {
      this.log(`Query activity callback failed: ${error}`);
    }
  }

  private notifyConnectionState(connected: boolean): void {
    try {
      if (connected) {
        this.activityCallbacks.onConnected?.();
      } else {
        this.activityCallbacks.onDisconnected?.();
      }
    } catch (error) {
      this.log(`Connection state callback failed: ${error}`);
    }
  }

  private async handleMCPQuery(
    data: any,
    callback: (response: any) => Promise<void>
  ): Promise<void> {
    let response: any;
    try {
      this.log(`Handling MCP query: ${data.method}`);

      // Check if the query handler exists in CONFIG.queries
      const queryKey = data.method; // Method already includes full path like 'foundry-mcp-bridge.listActors'
      const handler = CONFIG.queries[queryKey];

      if (!handler || typeof handler !== 'function') {
        throw new Error(`No handler found for query: ${data.method}`);
      }

      // Execute the query handler
      const result = await handler(data.data || {});

      this.log(`Query completed: ${data.method}`);
      response = { success: true, data: result };
    } catch (error) {
      this.log(
        `Query failed: ${data.method} - ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      response = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
    await callback(response);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.config.autoReconnect === false) return;
    // Never give up: after the configured fast attempts are exhausted, keep
    // retrying at a slow 30s cadence so MCP server restarts heal on their own.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay =
      this.reconnectAttempts >= this.maxReconnectAttempts
        ? 30000
        : Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    if (this.reconnectAttempts === this.maxReconnectAttempts + 1) {
      this.log(
        `Fast reconnection attempts exhausted (${this.maxReconnectAttempts}); switching to slow retry every 30s`
      );
    }
    this.log(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.connectionState = CONNECTION_STATES.RECONNECTING;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      try {
        await this.connect();
      } catch (error) {
        // Connection failed, scheduleReconnect will be called again from connect()
      }
    }, delay);
  }

  /** Push a game event to the MCP server (see event-service.ts). */
  sendEvent(event: unknown): void {
    void this.sendMessage({ type: 'bridge-event', event }).catch(() => {});
  }

  private async sendMessage(message: any): Promise<void> {
    if (this.disposed || this.connectionState !== CONNECTION_STATES.CONNECTED) {
      this.log('Cannot send message - not connected');
      return;
    }

    try {
      if (this.activeConnectionType === 'webrtc' && this.webrtc) {
        await this.webrtc.sendMessage(message);
      } else if (this.activeConnectionType === 'websocket' && this.ws) {
        this.ws.send(JSON.stringify(message));
      } else {
        this.log('No active connection to send message');
        throw new Error('No active connection to send message');
      }
      this.log(`Sent message via ${this.activeConnectionType}: ${message.type}`);
    } catch (error) {
      this.log(`Failed to send message: ${error}`);
      this.handleTransportFailure();
      throw error;
    }
  }

  emitToServer(event: string, data?: any): void {
    void this.sendMessage({
      type: event,
      data: data,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  isConnected(): boolean {
    return this.connectionState === CONNECTION_STATES.CONNECTED && this.isTransportReady();
  }

  private isTransportReady(): boolean {
    if (this.activeConnectionType === 'webrtc') {
      return this.webrtc?.isConnected() === true;
    }
    if (this.activeConnectionType === 'websocket') {
      return this.ws?.readyState === 1;
    }
    return false;
  }

  private handleTransportFailure(): void {
    const wasConnected = this.connectionState === CONNECTION_STATES.CONNECTED;

    if (this.webrtc) {
      const webrtc = this.webrtc;
      this.webrtc = null;
      webrtc.disconnect();
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    }

    this.activeConnectionType = null;
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    if (wasConnected) this.notifyConnectionState(false);
    this.scheduleReconnect();
  }

  getConnectionState(): string {
    return this.connectionState;
  }

  getConnectionInfo(): any {
    return {
      type: this.activeConnectionType,
      state: this.connectionState,
      disposed: this.disposed,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      standbyBecauseOwnerActive: this.standbyBecauseOwnerActive,
      config: {
        host: this.config.serverHost,
        port: this.config.serverPort,
        namespace: this.config.namespace,
      },
    };
  }

  private log(message: string): void {
    if (this.config.debugLogging) {
      console.log(`[${MODULE_ID}] Socket Bridge: ${message}`);
    }
  }
}
