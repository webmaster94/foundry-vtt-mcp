import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { Logger } from './logger.js';
import { Config } from './config.js';
import { WebRTCPeer, type WebRTCSendOptions } from './webrtc-peer.js';

export interface FoundryConnectorOptions {
  config: Config['foundry'];
  logger: Logger;
  /** Test/advanced override; defaults are deliberately tolerant of tab suspension. */
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
  queryTimeoutMs?: number;
  /** Test/advanced override for frozen-owner replacement age. */
  duplicateTakeoverStaleMs?: number;
  /** Unit-test override for ephemeral listeners; production signaling is always port + 1. */
  webrtcSignalingPortOverride?: number;
}

export interface FoundryConnectionInfo {
  started: boolean;
  connected: boolean;
  connectionType: 'websocket' | 'webrtc' | null;
  readyState: number | 'CLOSED';
  connectionGeneration: number;
  config: { port: number; namespace: string };
  liveness: {
    connectedAt: number | null;
    lastConnectedAt: number | null;
    lastApplicationSeenAt: number | null;
    lastWebSocketProtocolSeenAt: number | null;
    lastDisconnectedAt: number | null;
  };
}

interface PendingQuery {
  method: string;
  sendAttempted: boolean;
  abortController: AbortController;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_STALE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_QUERY_TIMEOUT_MS = 45_000;
const DUPLICATE_CONNECTION_CODE = 4009;
const REPLACED_CONNECTION_CODE = 4010;
const DEFAULT_DUPLICATE_TAKEOVER_STALE_MS = 2 * 60_000;
const MAX_SIGNALING_BODY_BYTES = 256 * 1024;

export class QueryTimeoutError extends Error {
  constructor(
    public readonly method: string,
    timeoutMs: number
  ) {
    super(`Query timeout after ${timeoutMs}ms: ${method}`);
    this.name = 'QueryTimeoutError';
  }
}

/** The transport vanished after a query may already have reached Foundry. */
export class QueryOutcomeUnknownError extends Error {
  constructor(public readonly method: string) {
    super(`Connection lost after query send; outcome is unknown: ${method}`);
    this.name = 'QueryOutcomeUnknownError';
  }
}

class SignalingPayloadTooLargeError extends Error {}
class SignalingRequestTimeoutError extends Error {}

export class FoundryConnector {
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private webrtcSignalingServer: Server | null = null;
  private logger: Logger;
  private config: Config['foundry'];
  private isStarted = false;
  private foundrySocket: WebSocket | null = null;
  private webrtcPeer: WebRTCPeer | null = null;
  private activeConnectionType: 'websocket' | 'webrtc' | null = null;
  private pendingQueries = new Map<string, PendingQuery>();
  private readonly queryIdPrefix = randomUUID();
  private queryIdCounter = 0;
  private connectionGeneration = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private sockets = new Set<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private heartbeatGeneration = 0;
  private lastApplicationSeenAt = 0;
  private lastWebSocketProtocolSeenAt = 0;
  private connectedAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private webSocketPongReceived = true;
  private heartbeatId = 0;
  private webrtcOfferStartedAt = 0;
  private webrtcTransitionSocket: WebSocket | null = null;
  private lastDisconnectedAt: number | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly staleTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly duplicateTakeoverStaleMs: number;
  private readonly webrtcSignalingPortOverride: number | undefined;

  /** Called for every unsolicited game event the module pushes (bridge-event). */
  public onBridgeEvent: ((event: any) => void) | null = null;

  constructor({
    config,
    logger,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    duplicateTakeoverStaleMs = DEFAULT_DUPLICATE_TAKEOVER_STALE_MS,
    webrtcSignalingPortOverride,
  }: FoundryConnectorOptions) {
    this.config = config;
    this.logger = logger.child({ component: 'FoundryConnector' });
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.staleTimeoutMs = Math.max(staleTimeoutMs, heartbeatIntervalMs * 2);
    this.queryTimeoutMs = queryTimeoutMs;
    this.duplicateTakeoverStaleMs = duplicateTakeoverStaleMs;
    this.webrtcSignalingPortOverride = webrtcSignalingPortOverride;
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.isStarted) {
      this.logger.debug('Foundry connector already started');
      return;
    }
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } catch (error) {
      await this.stopInternal();
      throw error;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    if (
      this.config.remoteMode &&
      (!this.config.authToken || this.config.authToken.trim().length < 16)
    ) {
      throw new Error('remoteMode requires an authToken of at least 16 characters');
    }
    this.logger.info('Starting Foundry connector WebSocket server', {
      port: this.config.port,
      protocol: this.config.protocol || 'ws',
      remoteMode: this.config.remoteMode || false,
    });

    // Create HTTP server for WebSocket connections
    const httpServer = createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.httpServer = httpServer;

    // Create SEPARATE HTTP server for WebRTC signaling.
    // Production signaling is always main port + 1 (31415 -> 31416),
    // matching the module's fixed transport contract.
    const WEBRTC_PORT = this.webrtcSignalingPortOverride ?? this.config.port + 1;
    const webrtcSignalingServer = createServer(async (req, res) => {
      // Set CORS headers for all requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle OPTIONS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Only handle POST to /webrtc-offer
      if (req.method === 'POST' && req.url === '/webrtc-offer') {
        try {
          await this.handleWebRTCOfferHTTP(req, res);
        } catch (error) {
          this.logger.error('WebRTC offer handling failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    this.webrtcSignalingServer = webrtcSignalingServer;

    // Start WebRTC signaling server (skipped for websocket-only profiles so
    // multiple websocket profiles don't fight over signaling ports)
    if (this.config.connectionType === 'websocket') {
      this.webrtcSignalingServer = null;
      this.logger.info('WebRTC signaling server skipped (websocket-only connection type)');
    } else {
      // Only expose beyond loopback when remote Foundry instances must reach us
      const bindHost = this.config.remoteMode ? '0.0.0.0' : '127.0.0.1';
      await new Promise<void>((resolve, reject) => {
        webrtcSignalingServer.listen(WEBRTC_PORT, bindHost, () => {
          this.logger.info(`WebRTC signaling server listening on ${bindHost}:${WEBRTC_PORT}`);
          console.error(`[WebRTC] Server started on ${bindHost}:${WEBRTC_PORT}`);
          resolve();
        });
        webrtcSignalingServer.on('error', (error: Error) => {
          this.logger.error('Failed to start WebRTC signaling server', error);
          console.error(`[WebRTC] Server error:`, error);
          reject(error);
        });
      });
    }

    // Create WebSocket server in noServer mode to avoid request consumption
    this.wss = new WebSocketServer({ noServer: true });

    // Manually handle upgrade for WebSocket connections
    this.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      // Only upgrade if path matches WebSocket namespace
      if (pathname !== (this.config.namespace || '/')) {
        socket.destroy();
        return;
      }

      // Shared-secret auth: when this profile configures authToken, reject
      // connections that don't present the matching token
      const expected = (this.config as any).authToken;
      if (expected && url.searchParams.get('token') !== expected) {
        this.logger.warn('Rejected WebSocket connection: missing or invalid auth token');
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(req, socket, head, ws => {
        this.wss?.emit('connection', ws, req);
      });
    });

    // One GM transport owns a profile at a time. A second tab is explicitly
    // rejected instead of being silently left open and ignored. The rejected
    // tab keeps its normal retry loop and can connect after the owner closes.
    this.wss.on('connection', ws => {
      this.sockets.add(ws);

      if (this.hasActiveConnection()) {
        if (this.isApplicationStaleForTakeover()) {
          this.logger.warn('Replacing application-unresponsive Foundry module owner');
          this.closeActiveConnection('A responsive duplicate is replacing the stale owner', {
            code: REPLACED_CONNECTION_CODE,
            reason: 'Replaced by a responsive Foundry module connection',
          });
        } else {
          this.logger.warn('Rejected duplicate Foundry module connection');
          ws.once('close', () => this.sockets.delete(ws));
          ws.close(DUPLICATE_CONNECTION_CODE, 'Another Foundry module connection is active');
          return;
        }
      }

      this.disposeStaleTransports();
      this.foundrySocket = ws;
      this.activeConnectionType = 'websocket';
      this.connectionGeneration += 1;
      const connectedAt = Date.now();
      this.connectedAt = connectedAt;
      this.lastConnectedAt = connectedAt;
      this.lastApplicationSeenAt = connectedAt;
      this.lastWebSocketProtocolSeenAt = connectedAt;
      this.webSocketPongReceived = true;
      this.logger.info('Foundry module registered via WebSocket');

      ws.on('pong', () => {
        if (this.foundrySocket === ws) {
          this.webSocketPongReceived = true;
          // Native WebSocket pongs are handled by the browser networking
          // stack even when a background tab's JavaScript timers are paused;
          // keep this distinct from proof that its module JS is responsive.
          this.lastWebSocketProtocolSeenAt = Date.now();
        }
      });

      ws.on('close', () => {
        this.sockets.delete(ws);
        if (this.foundrySocket === ws) {
          this.logger.info('Active Foundry WebSocket disconnected');
          this.foundrySocket = null;
          if (this.activeConnectionType === 'websocket') this.activeConnectionType = null;
          this.connectedAt = null;
          this.lastDisconnectedAt = Date.now();
          this.rejectPendingQueries(new Error('Connection closed'), true);
        }
      });

      ws.on('message', async data => {
        if (this.foundrySocket !== ws || this.activeConnectionType !== 'websocket') return;
        try {
          const message = JSON.parse(data.toString());
          this.lastApplicationSeenAt = Date.now();

          if (message.type === 'webrtc-offer') {
            await this.handleWebRTCOffer(message.offer, ws);
          } else {
            await this.handleMessage(message);
          }
        } catch (error) {
          this.logger.error('Failed to parse message', error);
        }
      });

      ws.on('error', error => {
        this.logger.error('WebSocket error', error);
      });
    });

    // Start the HTTP server (loopback-only unless remote instances connect in)
    await new Promise<void>((resolve, reject) => {
      const bindHost = this.config.remoteMode ? '0.0.0.0' : '127.0.0.1';
      httpServer.listen(this.config.port, bindHost, () => {
        this.isStarted = true;
        this.startHeartbeat();
        this.logger.info('Foundry connector listening', { host: bindHost, port: this.config.port });
        resolve();
      });

      httpServer.on('error', (error: Error) => {
        this.logger.error('Failed to start Foundry connector', error);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    const stopPromise = (async () => {
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch {
          // The failed start path also performs transactional cleanup.
        }
      }
      await this.stopInternal();
    })();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    if (
      !this.isStarted &&
      !this.httpServer &&
      !this.webrtcSignalingServer &&
      !this.wss &&
      !this.webrtcPeer &&
      this.sockets.size === 0
    ) {
      return;
    }

    this.logger.info('Stopping Foundry connector...');
    this.stopHeartbeat();
    this.isStarted = false;
    this.rejectPendingQueries(new Error('Server shutting down'), true);

    if (this.connectedAt !== null) this.lastDisconnectedAt = Date.now();
    this.activeConnectionType = null;
    this.connectedAt = null;
    this.foundrySocket = null;
    this.disposeWebRTCPeer();

    for (const socket of this.sockets) {
      try {
        socket.terminate();
      } catch {
        // Already closed.
      }
    }
    this.sockets.clear();

    const wss = this.wss;
    this.wss = null;
    if (wss) {
      await new Promise<void>(resolve => {
        try {
          wss.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    const httpServer = this.httpServer;
    const signalingServer = this.webrtcSignalingServer;
    this.httpServer = null;
    this.webrtcSignalingServer = null;
    await Promise.all([this.closeServer(httpServer), this.closeServer(signalingServer)]);
    this.logger.info('Foundry connector stopped');
  }

  private async handleMessage(message: any): Promise<void> {
    this.lastApplicationSeenAt = Date.now();

    if (message.type === 'bridge-event' && message.event) {
      try {
        this.onBridgeEvent?.(message.event);
      } catch (error) {
        this.logger.warn('Bridge event handler failed', error);
      }
      return;
    }

    if (message.type === 'mcp-response' && message.id) {
      const pending = this.pendingQueries.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.abortController.abort(new Error('Query response received'));
        this.pendingQueries.delete(message.id);

        if (message.data.success) {
          this.logger.debug('Query response received', {
            id: message.id,
            hasData: !!message.data.data,
          });
          pending.resolve(message.data.data);
        } else {
          this.logger.error('Query failed', { id: message.id, error: message.data.error });
          pending.reject(new Error(message.data.error || 'Query failed'));
        }
      }
      return;
    }

    if (message.type === 'pong') {
      const pending = this.pendingQueries.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.abortController.abort(new Error('Query response received'));
        this.pendingQueries.delete(message.id);
        pending.resolve(message.data);
      }
      return;
    }

    this.logger.debug('Received unknown message type', { type: message.type });
  }

  private async handleWebRTCOffer(offer: any, signalingWs: WebSocket): Promise<void> {
    let peer: WebRTCPeer | null = null;
    try {
      this.logger.info('Handling WebRTC offer for signaling');

      if (this.webrtcPeer) {
        throw new Error('A WebRTC handshake is already active');
      }

      peer = this.createWebRTCPeer(signalingWs);

      // Handle offer and get answer
      const answer = await peer.handleOffer(offer);
      if (this.webrtcPeer !== peer) throw new Error('WebRTC handshake was superseded');

      // Send answer back via signaling WebSocket
      signalingWs.send(
        JSON.stringify({
          type: 'webrtc-answer',
          answer: answer,
        })
      );

      this.logger.info('WebRTC answer sent; waiting for the data channel to open');
    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer', error);
      if (peer) this.disposeWebRTCPeer(peer);
      if (signalingWs.readyState === WebSocket.OPEN) {
        signalingWs.send(
          JSON.stringify({
            type: 'webrtc-error',
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        );
      }
    }
  }

  private async handleWebRTCOfferHTTP(req: any, res: any): Promise<void> {
    let peer: WebRTCPeer | null = null;
    try {
      // Read body using promise wrapper around classic events
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let settled = false;
        const timeout = setTimeout(
          () => {
            if (settled) return;
            settled = true;
            chunks.length = 0;
            req.resume();
            reject(new SignalingRequestTimeoutError('WebRTC signaling request timed out'));
          },
          Math.max(Math.min(this.config.connectionTimeout, 60_000), 1_000)
        );
        timeout.unref?.();

        req.on('data', (chunk: Buffer) => {
          if (settled) return;
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_SIGNALING_BODY_BYTES) {
            settled = true;
            clearTimeout(timeout);
            chunks.length = 0;
            req.resume();
            reject(new SignalingPayloadTooLargeError('WebRTC signaling payload is too large'));
            return;
          }
          chunks.push(chunk);
        });

        req.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(Buffer.concat(chunks).toString());
        });

        req.on('error', (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });
      });

      const { offer, token } = JSON.parse(body);

      // Shared-secret auth for the signaling path
      const expected = (this.config as any).authToken;
      if (expected && token !== expected) {
        this.logger.warn('Rejected WebRTC offer: missing or invalid auth token');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (!offer) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing offer in request body' }));
        return;
      }

      if (this.hasActiveConnection()) {
        if (this.isApplicationStaleForTakeover()) {
          this.logger.warn('Replacing application-unresponsive WebRTC owner via HTTP offer');
          this.closeActiveConnection('A responsive WebRTC offer is replacing the stale owner');
        } else {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Another Foundry module connection is active' }));
          return;
        }
      }

      if (this.webrtcPeer) {
        const handshakeTimeout = Math.max(this.config.connectionTimeout * 2, 20_000);
        if (Date.now() - this.webrtcOfferStartedAt < handshakeTimeout) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A WebRTC handshake is already active' }));
          return;
        }
        this.logger.warn('Disposing stale WebRTC handshake before accepting a new offer');
        this.disposeWebRTCPeer();
      }

      peer = this.createWebRTCPeer();

      // Handle offer and get answer
      const answer = await peer.handleOffer(offer);
      if (this.webrtcPeer !== peer) throw new Error('WebRTC handshake was superseded');

      // Send answer back via HTTP response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer }));
      this.logger.info('WebRTC answer returned; waiting for the data channel to open');
    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer via HTTP', error);
      if (peer) this.disposeWebRTCPeer(peer);
      const status =
        error instanceof SignalingPayloadTooLargeError
          ? 413
          : error instanceof SignalingRequestTimeoutError
            ? 408
            : 500;
      res.writeHead(status, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  private createWebRTCPeer(transitionSocket: WebSocket | null = null): WebRTCPeer {
    let peer!: WebRTCPeer;
    peer = new WebRTCPeer({
      config: this.config.webrtc,
      logger: this.logger,
      onMessage: async message => {
        if (this.webrtcPeer !== peer || this.activeConnectionType !== 'webrtc') return;
        this.lastApplicationSeenAt = Date.now();
        await this.handleMessage(message);
      },
      onConnectionStateChange: connected => this.handleWebRTCConnectionState(peer, connected),
    });
    this.webrtcPeer = peer;
    this.webrtcTransitionSocket = transitionSocket;
    this.webrtcOfferStartedAt = Date.now();
    return peer;
  }

  private handleWebRTCConnectionState(peer: WebRTCPeer, connected: boolean): void {
    if (this.webrtcPeer !== peer) return;

    if (connected) {
      if (this.foundrySocket?.readyState === WebSocket.OPEN) {
        if (this.foundrySocket !== this.webrtcTransitionSocket) {
          this.logger.warn('Rejected WebRTC data channel because another transport is active');
          this.disposeWebRTCPeer();
          return;
        }

        const signalingSocket = this.foundrySocket;
        this.foundrySocket = null;
        this.activeConnectionType = null;
        this.webrtcTransitionSocket = null;
        signalingSocket.close(1000, 'WebRTC data channel established');
      }

      this.activeConnectionType = 'webrtc';
      this.connectionGeneration += 1;
      const connectedAt = Date.now();
      this.connectedAt = connectedAt;
      this.lastConnectedAt = connectedAt;
      this.lastApplicationSeenAt = connectedAt;
      this.logger.info('Foundry module registered via open WebRTC data channel');
      return;
    }

    if (this.activeConnectionType === 'webrtc') {
      this.activeConnectionType = null;
      this.webrtcPeer = null;
      this.webrtcTransitionSocket = null;
      this.webrtcOfferStartedAt = 0;
      this.connectedAt = null;
      this.lastDisconnectedAt = Date.now();
      peer.disconnect();
      this.rejectPendingQueries(new Error('WebRTC data channel closed'), true);
      return;
    }

    // A terminal ICE/DTLS/data-channel failure can occur before the channel
    // ever opens. Release that pending handshake immediately so the module's
    // next offer is accepted instead of waiting for the stale-handshake timer.
    this.disposeWebRTCPeer(peer);
  }

  private hasActiveConnection(): boolean {
    return (
      this.foundrySocket?.readyState === WebSocket.OPEN ||
      this.webrtcPeer?.getIsConnected() === true
    );
  }

  private isApplicationStaleForTakeover(now = Date.now()): boolean {
    return (
      this.lastApplicationSeenAt > 0 &&
      now - this.lastApplicationSeenAt >= this.duplicateTakeoverStaleMs
    );
  }

  private disposeStaleTransports(): void {
    if (this.foundrySocket && this.foundrySocket.readyState !== WebSocket.OPEN) {
      try {
        this.foundrySocket.terminate();
      } catch {
        // Already closed.
      }
      this.foundrySocket = null;
      if (this.activeConnectionType === 'websocket') this.activeConnectionType = null;
      this.connectedAt = null;
    }

    if (this.webrtcPeer && !this.webrtcPeer.getIsConnected()) {
      this.disposeWebRTCPeer();
    }
  }

  private disposeWebRTCPeer(expectedPeer?: WebRTCPeer): void {
    if (expectedPeer && this.webrtcPeer !== expectedPeer) {
      expectedPeer.disconnect();
      return;
    }
    const peer = this.webrtcPeer;
    this.webrtcPeer = null;
    this.webrtcTransitionSocket = null;
    this.webrtcOfferStartedAt = 0;
    if (this.activeConnectionType === 'webrtc') {
      this.activeConnectionType = null;
      this.rejectPendingQueries(new Error('WebRTC connection closed'), true);
    }
    peer?.disconnect();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const generation = ++this.heartbeatGeneration;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      void this.performHeartbeat(generation).finally(() => {
        if (generation === this.heartbeatGeneration) this.heartbeatInFlight = false;
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    this.heartbeatGeneration++;
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private async performHeartbeat(generation: number): Promise<void> {
    if (generation !== this.heartbeatGeneration) return;
    const now = Date.now();
    const handshakeTimeout = Math.max(this.config.connectionTimeout * 2, 20_000);
    if (
      this.webrtcPeer &&
      !this.webrtcPeer.getIsConnected() &&
      now - this.webrtcOfferStartedAt >= handshakeTimeout
    ) {
      this.logger.warn('Closing stale WebRTC handshake');
      this.disposeWebRTCPeer();
    }

    if (!this.hasActiveConnection()) return;
    const connectionType = this.activeConnectionType;
    const foundrySocket = this.foundrySocket;
    const webrtcPeer = this.webrtcPeer;

    // WebSocket protocol pongs prove the native transport is alive even when
    // background-tab JavaScript is temporarily throttled. WebRTC has no
    // equivalent protocol pong, so retain a deliberately long application
    // responsiveness timeout there in addition to ICE/channel state.
    if (
      this.activeConnectionType === 'webrtc' &&
      now - this.lastApplicationSeenAt > this.staleTimeoutMs
    ) {
      this.closeActiveConnection('Application heartbeat timed out');
      return;
    }

    if (this.activeConnectionType === 'websocket' && this.foundrySocket) {
      if (!this.webSocketPongReceived) {
        this.closeActiveConnection('WebSocket protocol heartbeat timed out');
        return;
      }
      this.webSocketPongReceived = false;
      try {
        this.foundrySocket.ping();
      } catch (error) {
        this.logger.warn('WebSocket protocol ping failed', error);
        this.closeActiveConnection('WebSocket protocol ping failed');
        return;
      }
    }

    try {
      await this.sendToFoundry({ type: 'ping', id: `heartbeat-${++this.heartbeatId}` });
    } catch (error) {
      if (
        generation !== this.heartbeatGeneration ||
        connectionType !== this.activeConnectionType ||
        foundrySocket !== this.foundrySocket ||
        webrtcPeer !== this.webrtcPeer
      ) {
        return;
      }
      this.logger.warn('Application heartbeat send failed', error);
      this.closeActiveConnection('Application heartbeat send failed');
    }
  }

  private closeActiveConnection(
    reason: string,
    webSocketClose?: { code: number; reason: string }
  ): void {
    this.logger.warn(reason);
    const socket = this.foundrySocket;
    this.foundrySocket = null;
    if (this.activeConnectionType === 'websocket') this.activeConnectionType = null;
    if (socket) {
      try {
        if (webSocketClose) socket.close(webSocketClose.code, webSocketClose.reason);
        else socket.terminate();
      } catch {
        // Already closed.
      }
    }
    this.disposeWebRTCPeer();
    this.connectedAt = null;
    this.lastDisconnectedAt = Date.now();
    this.rejectPendingQueries(new Error(reason), true);
  }

  private rejectPendingQueries(error: Error, outcomeMayBeUnknown = false): void {
    for (const pending of this.pendingQueries.values()) {
      const { reject, timeout } = pending;
      clearTimeout(timeout);
      const rejection =
        outcomeMayBeUnknown && pending.sendAttempted
          ? new QueryOutcomeUnknownError(pending.method)
          : error;
      pending.abortController.abort(rejection);
      reject(rejection);
    }
    this.pendingQueries.clear();
  }

  private async closeServer(server: Server | null): Promise<void> {
    if (!server || !server.listening) return;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }

  async query(method: string, data?: any): Promise<any> {
    // Check connection based on active connection type
    const isConnected =
      this.activeConnectionType === 'webrtc'
        ? this.webrtcPeer && this.webrtcPeer.getIsConnected()
        : this.foundrySocket && this.foundrySocket.readyState === WebSocket.OPEN;

    if (!isConnected) {
      throw new Error('Not connected to Foundry VTT module');
    }

    const queryId = `query-${this.queryIdPrefix}-${++this.queryIdCounter}`;
    this.logger.debug('Sending query to Foundry', {
      method,
      data,
      queryId,
      connectionType: this.activeConnectionType,
    });

    return new Promise((resolve, reject) => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        const pending = this.pendingQueries.get(queryId);
        if (!pending) return;
        this.pendingQueries.delete(queryId);
        const error = new QueryTimeoutError(method, this.queryTimeoutMs);
        abortController.abort(error);
        reject(error);
      }, this.queryTimeoutMs);

      const pending: PendingQuery = {
        method,
        sendAttempted: false,
        abortController,
        resolve,
        reject,
        timeout,
      };
      this.pendingQueries.set(queryId, pending);

      const message = {
        type: 'mcp-query',
        id: queryId,
        data: { method, data },
      };

      // The timeout aborts a queued/backpressured send at the actual dispatch
      // point, so a timed-out write can never execute later.
      void this.sendToFoundry(message, {
        signal: abortController.signal,
        onSendAttempt: () => {
          if (this.pendingQueries.get(queryId) === pending) pending.sendAttempted = true;
        },
      }).catch(error => {
        if (this.pendingQueries.get(queryId) !== pending) return;
        clearTimeout(timeout);
        this.pendingQueries.delete(queryId);
        const sendError = error instanceof Error ? error : new Error(String(error));
        const rejection = pending.sendAttempted ? new QueryOutcomeUnknownError(method) : sendError;
        abortController.abort(rejection);
        reject(rejection);
      });
    });
  }

  async sendToFoundry(message: any, options: WebRTCSendOptions = {}): Promise<void> {
    if (this.activeConnectionType === 'webrtc' && this.webrtcPeer) {
      await this.webrtcPeer.sendMessage(message, options);
    } else if (
      this.activeConnectionType === 'websocket' &&
      this.foundrySocket &&
      this.foundrySocket.readyState === WebSocket.OPEN
    ) {
      const socket = this.foundrySocket;
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(
            options.signal.reason instanceof Error
              ? options.signal.reason
              : new Error('WebSocket message send was cancelled before dispatch')
          );
          return;
        }
        options.onSendAttempt?.();
        socket.send(JSON.stringify(message), error => {
          if (error) reject(error);
          else resolve();
        });
      });
    } else {
      throw new Error('Not connected to Foundry VTT module');
    }
  }

  isConnected(): boolean {
    if (!this.isStarted) return false;

    if (this.activeConnectionType === 'webrtc') {
      return this.webrtcPeer !== null && this.webrtcPeer.getIsConnected();
    } else if (this.activeConnectionType === 'websocket') {
      return this.foundrySocket !== null && this.foundrySocket.readyState === WebSocket.OPEN;
    }

    return false;
  }

  getConnectionInfo(): FoundryConnectionInfo {
    const address = this.httpServer?.address();
    return {
      started: this.isStarted,
      connected: this.isConnected(),
      connectionType: this.activeConnectionType,
      readyState: this.foundrySocket?.readyState ?? 'CLOSED',
      connectionGeneration: this.connectionGeneration,
      config: {
        port: typeof address === 'object' && address ? address.port : this.config.port,
        namespace: this.config.namespace,
      },
      liveness: {
        connectedAt: this.connectedAt,
        lastConnectedAt: this.lastConnectedAt,
        lastApplicationSeenAt: this.lastApplicationSeenAt || null,
        lastWebSocketProtocolSeenAt: this.lastWebSocketProtocolSeenAt || null,
        lastDisconnectedAt: this.lastDisconnectedAt,
      },
    };
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.activeConnectionType;
  }

  getLastDisconnectAt(): number | null {
    return this.lastDisconnectedAt;
  }

  /** Monotonically changes whenever a new module transport becomes active. */
  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  /**
   * Send a message to the connected Foundry module
   */
  async sendMessage(message: any): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Not connected to Foundry VTT module');
    }

    try {
      await this.sendToFoundry(message);
      this.logger.debug('Sent message to Foundry module', {
        type: message.type,
        connectionType: this.activeConnectionType,
      });
    } catch (error) {
      this.logger.error('Failed to send message to Foundry module', error);
      throw error;
    }
  }

  /**
   * Broadcast a message to all connected Foundry clients (alias for sendMessage for single connection)
   */
  async broadcastMessage(message: any): Promise<void> {
    await this.sendMessage(message);
  }
}
