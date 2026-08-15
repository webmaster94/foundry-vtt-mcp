import { MODULE_ID, CONNECTION_STATES } from './constants.js';

const MAX_DATA_CHANNEL_MESSAGE_BYTES = 64 * 1024;
const SINGLE_MESSAGE_BYTES = 48 * 1024;
const CHUNK_PAYLOAD_BYTES = 36 * 1024;
const MAX_REASSEMBLED_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS_PER_MESSAGE = Math.ceil(MAX_REASSEMBLED_MESSAGE_BYTES / CHUNK_PAYLOAD_BYTES);
const MAX_PENDING_CHUNKED_MESSAGES = 16;
const MAX_TOTAL_PENDING_CHUNK_BYTES = 32 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 30_000;
const CHUNK_CLEANUP_INTERVAL_MS = 5_000;
const BUFFERED_AMOUNT_HIGH_WATER = 512 * 1024;
const BUFFERED_AMOUNT_LOW_WATER = 128 * 1024;

interface PendingChunkedMessage {
  chunks: Map<number, Uint8Array>;
  totalChunks: number;
  totalBytes: number;
  originalType: string;
  originalId?: string;
  timestamp: number;
}

export interface WebRTCConfig {
  serverHost: string;
  serverPort: number;
  namespace: string;
  stunServers: string[];
  connectionTimeout: number;
  debugLogging: boolean;
  /** Optional shared secret; must match the MCP server profile's authToken. */
  authToken?: string;
}

/**
 * WebRTC peer connection for browser-to-server communication
 * Uses HTTP POST for signaling (localhost exception allows HTTP from HTTPS)
 * Then establishes encrypted WebRTC DataChannel for P2P connection without SSL certificates
 */
export class WebRTCConnection {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private connectionState: string = CONNECTION_STATES.DISCONNECTED;
  private messageHandler: ((message: any) => Promise<void>) | null = null;
  private disconnectGraceTimer: number | null = null;
  private pendingChunks = new Map<string, PendingChunkedMessage>();
  private chunkCleanupInterval: number | null = null;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    private config: WebRTCConfig,
    private onConnectionStateChange?: (connected: boolean) => void
  ) {}

  async connect(onMessage: (message: any) => Promise<void>): Promise<void> {
    if (
      this.connectionState === CONNECTION_STATES.CONNECTED ||
      this.connectionState === CONNECTION_STATES.CONNECTING
    ) {
      return;
    }

    this.setConnectionState(CONNECTION_STATES.CONNECTING);
    this.messageHandler = onMessage;
    this.log('Starting WebRTC connection...');

    try {
      // Step 1: Create WebRTC peer connection
      this.peerConnection = new RTCPeerConnection({
        iceServers: this.config.stunServers.map(url => ({ urls: url })),
      });

      // Step 2: Create data channel
      this.dataChannel = this.peerConnection.createDataChannel('foundry-mcp', {
        ordered: true,
      });

      this.setupDataChannelHandlers();
      this.setupPeerConnectionHandlers();

      // Step 3: Create offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // Step 4: Wait for ICE gathering
      await this.waitForIceGathering();

      // Step 5: Send offer to server via signaling WebSocket
      await this.sendSignalingOffer(this.peerConnection.localDescription!);

      this.log('WebRTC connection initiated');
    } catch (error) {
      this.log(`WebRTC connection failed: ${error}`);
      this.setConnectionState(CONNECTION_STATES.DISCONNECTED);
      throw error;
    }
  }

  private setupDataChannelHandlers(): void {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      this.log('WebRTC data channel opened');
      this.setConnectionState(CONNECTION_STATES.CONNECTED);
    };

    this.dataChannel.onclose = () => {
      this.log('WebRTC data channel closed');
      this.setConnectionState(CONNECTION_STATES.DISCONNECTED);
    };

    this.dataChannel.onerror = error => {
      this.log(`WebRTC data channel error: ${error}`);
    };

    this.dataChannel.onmessage = async event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'chunked-message') {
          await this.handleChunkedMessage(message);
          return;
        }
        if (this.messageHandler) {
          await this.messageHandler(message);
        }
      } catch (error) {
        this.log(`Failed to parse WebRTC message: ${error}`);
      }
    };
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.peerConnection) return;

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      this.log(`ICE connection state: ${state}`);

      if (state === 'failed' || state === 'closed') {
        this.clearDisconnectGraceTimer();
        this.setConnectionState(CONNECTION_STATES.DISCONNECTED);
      } else if (state === 'disconnected') {
        this.scheduleDisconnectGrace();
      } else if (state === 'connected' || state === 'completed') {
        this.clearDisconnectGraceIfRecovered();
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      this.log(`Peer connection state: ${state}`);
      if (state === 'failed' || state === 'closed') {
        this.clearDisconnectGraceTimer();
        this.setConnectionState(CONNECTION_STATES.DISCONNECTED);
      } else if (state === 'disconnected') {
        this.scheduleDisconnectGrace();
      } else if (state === 'connected') {
        this.clearDisconnectGraceIfRecovered();
      }
    };
  }

  private async waitForIceGathering(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ICE gathering timeout'));
      }, this.config.connectionTimeout * 1000);

      if (this.peerConnection?.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.peerConnection!.onicegatheringstatechange = () => {
        if (this.peerConnection?.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
  }

  private async sendSignalingOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    // Use HTTP POST for signaling to the dedicated port. Loopback HTTP is a
    // trustworthy target from an HTTPS world; a deliberately configured LAN
    // host is also preserved and may require Local Network Access permission.
    const isHttps = window.location.protocol === 'https:';
    const signalingHost = this.config.serverHost;
    const protocol = 'http';
    // Signaling port is main server port + 1 (31415 -> 31416), matching the
    // MCP server's per-profile signaling listener
    const WEBRTC_SIGNALING_PORT = (this.config.serverPort ?? 31415) + 1;
    const httpUrl = `${protocol}://${signalingHost}:${WEBRTC_SIGNALING_PORT}/webrtc-offer`;

    this.log(`Sending WebRTC offer via HTTP POST: ${httpUrl} (HTTPS page: ${isHttps})`);

    try {
      const requestInit: RequestInit & { targetAddressSpace?: 'loopback' | 'local' } = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          offer,
          ...(this.config.authToken ? { token: this.config.authToken } : {}),
        }),
        signal: AbortSignal.timeout(this.config.connectionTimeout * 1000),
      };
      if (isHttps) {
        requestInit.targetAddressSpace = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(
          signalingHost
        )
          ? 'loopback'
          : 'local';
      }
      const response = await fetch(httpUrl, requestInit);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const { answer } = await response.json();

      if (!answer) {
        throw new Error('No answer received from server');
      }

      this.log('Received WebRTC answer from server via HTTP');
      await this.peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Signaling via HTTP failed: ${errorMsg}`);
      throw error; // Re-throw original error instead of wrapping
    }
  }

  disconnect(): void {
    this.clearDisconnectGraceTimer();
    this.stopChunkCleanup();
    this.pendingChunks.clear();
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.setConnectionState(CONNECTION_STATES.DISCONNECTED);
    this.log('WebRTC connection closed');
  }

  sendMessage(message: any): Promise<void> {
    const operation = this.sendChain.then(() => this.sendMessageNow(message));
    this.sendChain = operation.catch(() => {});
    return operation;
  }

  private async sendMessageNow(message: any): Promise<void> {
    const dataChannel = this.dataChannel;
    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error('Cannot send WebRTC message: data channel is not open');
    }

    const json = JSON.stringify(message);
    const encoded = new TextEncoder().encode(json);
    if (encoded.byteLength > MAX_REASSEMBLED_MESSAGE_BYTES) {
      throw new Error(
        `WebRTC message is ${encoded.byteLength} bytes; maximum is ${MAX_REASSEMBLED_MESSAGE_BYTES}`
      );
    }

    if (encoded.byteLength <= SINGLE_MESSAGE_BYTES) {
      await this.waitForBufferCapacity(dataChannel);
      dataChannel.send(json);
      return;
    }

    const totalChunks = Math.ceil(encoded.byteLength / CHUNK_PAYLOAD_BYTES);
    const chunkId = `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_PAYLOAD_BYTES;
      const chunkBytes = encoded.subarray(
        start,
        Math.min(start + CHUNK_PAYLOAD_BYTES, encoded.byteLength)
      );
      const chunkJson = JSON.stringify({
        type: 'chunked-message',
        chunkId,
        chunkIndex,
        totalChunks,
        chunk: this.bytesToBase64(chunkBytes),
        encoding: 'base64',
        byteLength: chunkBytes.byteLength,
        totalBytes: encoded.byteLength,
        originalType: String(message?.type || ''),
        ...(typeof message?.id === 'string' ? { originalId: message.id } : {}),
      });
      const envelopeBytes = new TextEncoder().encode(chunkJson).byteLength;
      if (envelopeBytes > MAX_DATA_CHANNEL_MESSAGE_BYTES) {
        throw new Error(`WebRTC chunk envelope is ${envelopeBytes} bytes; maximum is 65536`);
      }
      await this.waitForBufferCapacity(dataChannel);
      dataChannel.send(chunkJson);
    }
  }

  private async waitForBufferCapacity(dataChannel: RTCDataChannel): Promise<void> {
    if (dataChannel.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATER) return;
    dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_WATER;

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + Math.max(this.config.connectionTimeout * 1000, 5_000);
      const interval = window.setInterval(() => {
        if (this.dataChannel !== dataChannel || dataChannel.readyState !== 'open') {
          clearInterval(interval);
          reject(new Error('WebRTC data channel closed while waiting for send buffer'));
        } else if (dataChannel.bufferedAmount <= BUFFERED_AMOUNT_LOW_WATER) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() >= deadline) {
          clearInterval(interval);
          reject(new Error('WebRTC send buffer did not drain before timeout'));
        }
      }, 10);
    });
  }

  private async handleChunkedMessage(message: any): Promise<void> {
    const { chunkId, chunkIndex, totalChunks, chunk, encoding, byteLength, totalBytes } = message;
    if (
      typeof chunkId !== 'string' ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) ||
      chunkIndex < 0 ||
      totalChunks < 1 ||
      chunkIndex >= totalChunks ||
      totalChunks > MAX_CHUNKS_PER_MESSAGE ||
      typeof chunk !== 'string'
    ) {
      throw new Error('Rejected malformed WebRTC chunk metadata');
    }

    if (
      encoding !== 'base64' ||
      !Number.isInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > CHUNK_PAYLOAD_BYTES ||
      !Number.isInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes > MAX_REASSEMBLED_MESSAGE_BYTES ||
      totalChunks !== Math.ceil(totalBytes / CHUNK_PAYLOAD_BYTES)
    ) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected malformed or oversized WebRTC chunk payload');
    }

    this.startChunkCleanup();
    this.cleanupExpiredChunks();
    let pending = this.pendingChunks.get(chunkId);
    if (!pending) {
      if (this.pendingChunks.size >= MAX_PENDING_CHUNKED_MESSAGES) {
        throw new Error('Too many pending WebRTC chunked messages');
      }
      pending = {
        chunks: new Map(),
        totalChunks,
        totalBytes,
        originalType: String(message.originalType || ''),
        timestamp: Date.now(),
      };
      if (typeof message.originalId === 'string') pending.originalId = message.originalId;
      this.pendingChunks.set(chunkId, pending);
    }

    if (
      pending.totalChunks !== totalChunks ||
      pending.totalBytes !== totalBytes ||
      pending.originalType !== String(message.originalType || '') ||
      pending.originalId !==
        (typeof message.originalId === 'string' ? message.originalId : undefined)
    ) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected inconsistent WebRTC chunk metadata');
    }

    let decoded: Uint8Array;
    try {
      decoded = this.base64ToBytes(chunk);
    } catch (error) {
      this.pendingChunks.delete(chunkId);
      throw error;
    }
    if (decoded.byteLength !== byteLength) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected WebRTC chunk with an invalid byte length');
    }
    const existing = pending.chunks.get(chunkIndex);
    if (existing) {
      if (!this.equalBytes(existing, decoded)) {
        this.pendingChunks.delete(chunkId);
        throw new Error('Rejected conflicting duplicate WebRTC chunk');
      }
      return;
    }
    const aggregatePendingBytes = [...this.pendingChunks.values()].reduce(
      (sum, value) =>
        sum +
        [...value.chunks.values()].reduce((chunkSum, bytes) => chunkSum + bytes.byteLength, 0),
      0
    );
    if (aggregatePendingBytes + decoded.byteLength > MAX_TOTAL_PENDING_CHUNK_BYTES) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected WebRTC chunks exceeding aggregate reassembly memory limit');
    }
    pending.chunks.set(chunkIndex, decoded);
    pending.timestamp = Date.now();

    const receivedBytes = [...pending.chunks.values()].reduce(
      (sum, value) => sum + value.byteLength,
      0
    );
    if (receivedBytes > pending.totalBytes) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected oversized WebRTC chunk sequence');
    }
    if (pending.chunks.size !== pending.totalChunks) return;

    this.pendingChunks.delete(chunkId);
    if (receivedBytes !== pending.totalBytes) {
      throw new Error('Rejected incomplete WebRTC chunk byte sequence');
    }
    const reassembled = new Uint8Array(pending.totalBytes);
    let offset = 0;
    for (let index = 0; index < pending.totalChunks; index++) {
      const value = pending.chunks.get(index);
      if (!value) throw new Error('Rejected incomplete WebRTC chunk sequence');
      reassembled.set(value, offset);
      offset += value.byteLength;
    }

    const json = new TextDecoder('utf-8', { fatal: true }).decode(reassembled);
    const completeMessage = JSON.parse(json);
    if (
      String(completeMessage?.type || '') !== pending.originalType ||
      (pending.originalId !== undefined && completeMessage?.id !== pending.originalId)
    ) {
      throw new Error('Rejected WebRTC chunks whose envelope metadata did not match the message');
    }
    if (this.messageHandler) await this.messageHandler(completeMessage);
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let index = 0; index < bytes.byteLength; index++) {
      binary += String.fromCharCode(bytes[index]!);
    }
    return btoa(binary);
  }

  private base64ToBytes(value: string): Uint8Array {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error('Rejected invalid base64 WebRTC chunk');
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  private startChunkCleanup(): void {
    if (this.chunkCleanupInterval !== null) return;
    this.chunkCleanupInterval = window.setInterval(
      () => this.cleanupExpiredChunks(),
      CHUNK_CLEANUP_INTERVAL_MS
    );
  }

  private stopChunkCleanup(): void {
    if (this.chunkCleanupInterval === null) return;
    clearInterval(this.chunkCleanupInterval);
    this.chunkCleanupInterval = null;
  }

  private cleanupExpiredChunks(): void {
    const cutoff = Date.now() - CHUNK_TIMEOUT_MS;
    for (const [chunkId, pending] of this.pendingChunks) {
      if (pending.timestamp <= cutoff) this.pendingChunks.delete(chunkId);
    }
    if (this.pendingChunks.size === 0) this.stopChunkCleanup();
  }

  isConnected(): boolean {
    return this.connectionState === CONNECTION_STATES.CONNECTED;
  }

  getConnectionState(): string {
    return this.connectionState;
  }

  async waitUntilConnected(): Promise<void> {
    if (this.isConnected()) return;

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        if (this.isConnected()) {
          clearInterval(interval);
          resolve();
          return;
        }

        if (
          this.connectionState === CONNECTION_STATES.DISCONNECTED ||
          Date.now() - startedAt >= this.config.connectionTimeout * 1000
        ) {
          clearInterval(interval);
          reject(new Error('WebRTC data channel connection timeout'));
        }
      }, 25);
    });
  }

  private setConnectionState(state: string): void {
    const wasConnected = this.connectionState === CONNECTION_STATES.CONNECTED;
    this.connectionState = state;
    const isConnected = state === CONNECTION_STATES.CONNECTED;

    if (wasConnected !== isConnected) {
      try {
        this.onConnectionStateChange?.(isConnected);
      } catch (error) {
        this.log(`Connection state callback failed: ${error}`);
      }
    }
  }

  private clearDisconnectGraceTimer(): void {
    if (this.disconnectGraceTimer === null) return;
    clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
  }

  private scheduleDisconnectGrace(): void {
    this.clearDisconnectGraceTimer();
    this.disconnectGraceTimer = window.setTimeout(
      () => {
        this.disconnectGraceTimer = null;
        if (
          this.peerConnection?.iceConnectionState === 'disconnected' ||
          this.peerConnection?.connectionState === 'disconnected'
        ) {
          this.setConnectionState(CONNECTION_STATES.DISCONNECTED);
        }
      },
      Math.max(this.config.connectionTimeout * 1000, 5_000)
    );
  }

  private clearDisconnectGraceIfRecovered(): void {
    if (
      this.peerConnection?.iceConnectionState !== 'disconnected' &&
      this.peerConnection?.connectionState !== 'disconnected'
    ) {
      this.clearDisconnectGraceTimer();
    }
  }

  private log(message: string): void {
    if (this.config.debugLogging) {
      console.log(`[${MODULE_ID}] WebRTC: ${message}`);
    }
  }
}
