import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { Logger } from './logger.js';
import type { Config } from './config.js';
import { WEBRTC_CONSTANTS } from './config.js';

const SINGLE_MESSAGE_BYTES = 48 * 1024;
const CHUNK_PAYLOAD_BYTES = 36 * 1024;
const MAX_REASSEMBLED_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS_PER_MESSAGE = Math.ceil(MAX_REASSEMBLED_MESSAGE_BYTES / CHUNK_PAYLOAD_BYTES);
const MAX_PENDING_CHUNKED_MESSAGES = 16;
const MAX_TOTAL_PENDING_CHUNK_BYTES = 32 * 1024 * 1024;
const BUFFERED_AMOUNT_HIGH_WATER = 512 * 1024;
const BUFFERED_AMOUNT_LOW_WATER = 128 * 1024;
const SEND_BUFFER_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 10_000;

export interface WebRTCPeerOptions {
  config: Config['foundry']['webrtc'];
  logger: Logger;
  onMessage: (message: any) => Promise<void>;
  onConnectionStateChange?: (connected: boolean) => void;
}

export interface WebRTCSendOptions {
  signal?: AbortSignal;
  onSendAttempt?: () => void;
}

/**
 * WebRTC peer connection for Node.js server
 * Handles WebRTC signaling and data channel communication
 */
export class WebRTCPeer {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: any = null;
  private logger: Logger;
  private config: Config['foundry']['webrtc'];
  private onMessageHandler: (message: any) => Promise<void>;
  private onConnectionStateChange: ((connected: boolean) => void) | undefined;
  private isConnected = false;
  private hasReportedConnectionState = false;
  private pendingChunks: Map<
    string,
    {
      chunks: Map<number, Buffer>;
      totalChunks: number;
      totalBytes: number | null;
      receivedBytes: number;
      originalType: string;
      originalId?: string;
      encoding: 'base64' | 'legacy-utf8';
      timestamp: number; // For timeout cleanup
    }
  > = new Map();
  private chunkCleanupInterval: NodeJS.Timeout | null = null;
  private disconnectGraceTimer: NodeJS.Timeout | null = null;
  private sendChain: Promise<void> = Promise.resolve();

  constructor({ config, logger, onMessage, onConnectionStateChange }: WebRTCPeerOptions) {
    this.config = config;
    this.logger = logger.child({ component: 'WebRTCPeer' });
    this.onMessageHandler = onMessage;
    this.onConnectionStateChange = onConnectionStateChange;

    // Start cleanup interval for timed-out chunks
    this.startChunkCleanup();
  }

  /**
   * Handle incoming WebRTC offer from browser client
   * Returns answer to be sent back to client
   *
   * Critical: Send answer IMMEDIATELY, then trickle ICE candidates
   * Don't wait for data channel or ICE gathering before answering
   */
  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const startTime = Date.now();
    this.logger.info('[WebRTC Timing] Received offer from client');

    // Create peer connection WITHOUT STUN servers for localhost connections
    this.peerConnection = new RTCPeerConnection({
      iceServers: [], // Empty for localhost - no external STUN needed
    });

    this.setupPeerConnectionHandlers();

    // Step 1: Set remote description (offer from client)
    const t1 = Date.now();
    await this.peerConnection.setRemoteDescription(offer as any);
    this.logger.info(`[WebRTC Timing] setRemoteDescription took ${Date.now() - t1}ms`);

    // Step 2: Create answer IMMEDIATELY - don't wait for data channel or ICE
    const t2 = Date.now();
    const answer = await this.peerConnection.createAnswer();
    this.logger.info(`[WebRTC Timing] createAnswer took ${Date.now() - t2}ms`);

    // Step 3: Set local description
    const t3 = Date.now();
    await this.peerConnection.setLocalDescription(answer);
    this.logger.info(`[WebRTC Timing] setLocalDescription took ${Date.now() - t3}ms`);

    this.logger.info(
      `[WebRTC Timing] Answer ready in ${Date.now() - startTime}ms - sending immediately`
    );

    // Data channel and ICE will arrive later via events - don't wait!
    // The ondatachannel event will fire when the channel is ready

    return this.peerConnection.localDescription as RTCSessionDescriptionInit;
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.peerConnection) return;

    // ICE gathering state changes
    this.peerConnection.iceGatheringStateChange.subscribe(state => {
      this.logger.info(`[WebRTC] ICE gathering state: ${state}`);
    });

    // ICE connection state changes
    this.peerConnection.iceConnectionStateChange.subscribe(state => {
      this.logger.info(`[WebRTC] ICE connection state: ${state}`);

      if (state === 'failed') {
        this.clearDisconnectGraceTimer();
        this.logger.error('[WebRTC] ICE connection failed - check STUN/TURN config or firewall');
        this.setConnected(false, true);
      } else if (state === 'closed') {
        this.clearDisconnectGraceTimer();
        this.setConnected(false, true);
      } else if (state === 'disconnected') {
        this.scheduleDisconnectGrace();
      } else if (state === 'connected') {
        this.logger.info('[WebRTC] ICE connection established');
        this.clearDisconnectGraceIfRecovered();
      }
    });

    // Overall peer connection state
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      this.logger.info(`[WebRTC] Peer connection state: ${state}`);

      if (state === 'connected') {
        this.logger.info('[WebRTC] Peer connection fully established');
        this.clearDisconnectGraceIfRecovered();
      } else if (state === 'failed') {
        this.clearDisconnectGraceTimer();
        this.logger.error('[WebRTC] Peer connection failed - DTLS handshake may have failed');
        this.setConnected(false, true);
      } else if (state === 'closed') {
        this.clearDisconnectGraceTimer();
        this.setConnected(false, true);
      } else if (state === 'disconnected') {
        this.scheduleDisconnectGrace();
      }
    };

    // Data channel from client (critical event!)
    this.peerConnection.ondatachannel = (event: any) => {
      this.logger.info('[WebRTC] Data channel received from client!');
      this.dataChannel = event.channel;
      this.setupDataChannelHandlers();
    };
  }

  private setupDataChannelHandlers(): void {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      this.logger.info('[WebRTC] ✓ Data channel opened - connection fully ready!');
      this.setConnected(true);
    };

    this.dataChannel.onclose = () => {
      this.logger.info('[WebRTC] Data channel closed');
      this.clearDisconnectGraceTimer();
      this.setConnected(false, true);
    };

    this.dataChannel.onerror = (error: any) => {
      this.logger.error('[WebRTC] Data channel error:', error);
    };

    this.dataChannel.onmessage = async (event: any) => {
      try {
        this.logger.debug('Data channel received message', {
          dataLength: event.data?.length,
          dataPreview: event.data?.substring(0, 100),
        });
        const message = JSON.parse(event.data);

        // Handle chunked messages
        if (message.type === 'chunked-message') {
          await this.handleChunkedMessage(message);
          return;
        }

        this.logger.debug('Parsed message successfully', {
          type: message.type,
          requestId: message.requestId,
          hasData: !!message.data,
        });
        await this.onMessageHandler(message);
        this.logger.debug('Message handler completed', { type: message.type });
      } catch (error) {
        this.logger.error('Failed to parse or handle message', {
          error: error instanceof Error ? error.message : String(error),
          rawData: event.data?.substring(0, 200),
        });
      }
    };

    // Some implementations can deliver the data-channel event after the
    // channel has already transitioned to open.
    if (this.dataChannel.readyState === 'open') {
      this.setConnected(true);
    }
  }

  sendMessage(message: any, options: WebRTCSendOptions = {}): Promise<void> {
    const operation = this.sendChain.then(() => this.sendMessageNow(message, options));
    this.sendChain = operation.catch(() => {});
    return operation;
  }

  private async sendMessageNow(message: any, options: WebRTCSendOptions): Promise<void> {
    this.throwIfSendAborted(options.signal);
    const dataChannel = this.dataChannel;
    if (!dataChannel || !this.isConnected || dataChannel.readyState !== 'open') {
      throw new Error('Cannot send WebRTC message: data channel is not open');
    }

    try {
      const json = JSON.stringify(message);
      const encoded = Buffer.from(json, 'utf8');
      if (encoded.byteLength > MAX_REASSEMBLED_MESSAGE_BYTES) {
        throw new Error(
          `WebRTC message is ${encoded.byteLength} bytes; maximum is ${MAX_REASSEMBLED_MESSAGE_BYTES}`
        );
      }

      let sendAttemptReported = false;
      const dispatch = (payload: string): void => {
        this.throwIfSendAborted(options.signal);
        if (!sendAttemptReported) {
          options.onSendAttempt?.();
          sendAttemptReported = true;
        }
        dataChannel.send(payload);
      };

      if (encoded.byteLength <= SINGLE_MESSAGE_BYTES) {
        await this.waitForBufferCapacity(dataChannel, options.signal);
        dispatch(json);
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
          chunk: chunkBytes.toString('base64'),
          encoding: 'base64',
          byteLength: chunkBytes.byteLength,
          totalBytes: encoded.byteLength,
          originalType: String(message?.type || ''),
          ...(typeof message?.id === 'string' ? { originalId: message.id } : {}),
        });
        if (Buffer.byteLength(chunkJson, 'utf8') > WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE) {
          throw new Error('WebRTC chunk envelope exceeds the SCTP message limit');
        }
        await this.waitForBufferCapacity(dataChannel, options.signal);
        dispatch(chunkJson);
      }
    } catch (error) {
      this.logger.error('Failed to send WebRTC message', error);
      throw error;
    }
  }

  private async waitForBufferCapacity(dataChannel: any, signal?: AbortSignal): Promise<void> {
    this.throwIfSendAborted(signal);
    if ((dataChannel.bufferedAmount ?? 0) <= BUFFERED_AMOUNT_HIGH_WATER) return;
    dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_WATER;
    const deadline = Date.now() + SEND_BUFFER_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(interval);
          reject(this.getAbortReason(signal));
        } else if (this.dataChannel !== dataChannel || dataChannel.readyState !== 'open') {
          clearInterval(interval);
          reject(new Error('WebRTC data channel closed while waiting for send buffer'));
        } else if ((dataChannel.bufferedAmount ?? 0) <= BUFFERED_AMOUNT_LOW_WATER) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() >= deadline) {
          clearInterval(interval);
          reject(new Error('WebRTC send buffer did not drain before timeout'));
        }
      }, 10);
      interval.unref?.();
    });
  }

  private throwIfSendAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.getAbortReason(signal);
  }

  private getAbortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('WebRTC message send was cancelled before dispatch');
  }

  /**
   * Handle incoming chunked message fragments
   * Validates chunks, stores them, and reassembles when all pieces arrive
   */
  private async handleChunkedMessage(chunkMessage: any): Promise<void> {
    const {
      chunkId,
      chunkIndex,
      totalChunks,
      chunk,
      encoding,
      byteLength,
      totalBytes,
      originalType,
      originalId,
    } = chunkMessage;
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

    const isBase64 = encoding === 'base64';
    if (encoding !== undefined && !isBase64) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected unsupported WebRTC chunk encoding');
    }
    if (
      isBase64 &&
      (!Number.isInteger(byteLength) ||
        byteLength < 0 ||
        byteLength > CHUNK_PAYLOAD_BYTES ||
        !Number.isInteger(totalBytes) ||
        totalBytes < 1 ||
        totalBytes > MAX_REASSEMBLED_MESSAGE_BYTES ||
        totalChunks !== Math.ceil(totalBytes / CHUNK_PAYLOAD_BYTES))
    ) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected malformed or oversized WebRTC chunk payload');
    }

    let chunkBytes: Buffer;
    if (isBase64) {
      if (chunk.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) {
        this.pendingChunks.delete(chunkId);
        throw new Error('Rejected invalid base64 WebRTC chunk');
      }
      chunkBytes = Buffer.from(chunk, 'base64');
      if (chunkBytes.byteLength !== byteLength) {
        this.pendingChunks.delete(chunkId);
        throw new Error('Rejected WebRTC chunk with an invalid byte length');
      }
    } else {
      chunkBytes = Buffer.from(chunk, 'utf8');
      if (chunkBytes.byteLength > WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE) {
        throw new Error('Rejected oversized legacy WebRTC chunk');
      }
    }

    let pending = this.pendingChunks.get(chunkId);
    if (!pending) {
      if (this.pendingChunks.size >= MAX_PENDING_CHUNKED_MESSAGES) {
        throw new Error('Too many pending WebRTC chunked messages');
      }
      pending = {
        chunks: new Map(),
        totalChunks,
        totalBytes: isBase64 ? totalBytes : null,
        receivedBytes: 0,
        originalType: String(originalType || ''),
        encoding: isBase64 ? 'base64' : 'legacy-utf8',
        timestamp: Date.now(),
      };
      if (typeof originalId === 'string') pending.originalId = originalId;
      this.pendingChunks.set(chunkId, pending);
    }

    if (
      pending.totalChunks !== totalChunks ||
      pending.totalBytes !== (isBase64 ? totalBytes : null) ||
      pending.originalType !== String(originalType || '') ||
      pending.originalId !== (typeof originalId === 'string' ? originalId : undefined) ||
      pending.encoding !== (isBase64 ? 'base64' : 'legacy-utf8')
    ) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected inconsistent WebRTC chunk metadata');
    }

    const existing = pending.chunks.get(chunkIndex);
    if (existing) {
      if (!existing.equals(chunkBytes)) {
        this.pendingChunks.delete(chunkId);
        throw new Error('Rejected conflicting duplicate WebRTC chunk');
      }
      return;
    }
    const aggregatePendingBytes = [...this.pendingChunks.values()].reduce(
      (sum, value) => sum + value.receivedBytes,
      0
    );
    if (aggregatePendingBytes + chunkBytes.byteLength > MAX_TOTAL_PENDING_CHUNK_BYTES) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected WebRTC chunks exceeding aggregate reassembly memory limit');
    }
    pending.chunks.set(chunkIndex, chunkBytes);
    pending.receivedBytes += chunkBytes.byteLength;
    pending.timestamp = Date.now();
    if (pending.receivedBytes > MAX_REASSEMBLED_MESSAGE_BYTES) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected oversized WebRTC chunk sequence');
    }
    if (pending.totalBytes !== null && pending.receivedBytes > pending.totalBytes) {
      this.pendingChunks.delete(chunkId);
      throw new Error('Rejected WebRTC chunks exceeding their declared byte length');
    }
    if (pending.chunks.size !== pending.totalChunks) return;

    this.pendingChunks.delete(chunkId);
    if (pending.totalBytes !== null && pending.receivedBytes !== pending.totalBytes) {
      throw new Error('Rejected incomplete WebRTC chunk byte sequence');
    }
    const orderedChunks: Buffer[] = [];
    for (let index = 0; index < pending.totalChunks; index++) {
      const value = pending.chunks.get(index);
      if (!value) throw new Error('Rejected incomplete WebRTC chunk sequence');
      orderedChunks.push(value);
    }
    const reassembled = Buffer.concat(orderedChunks, pending.receivedBytes);
    const json = new TextDecoder('utf-8', { fatal: true }).decode(reassembled);
    const completeMessage = JSON.parse(json);
    if (
      String(completeMessage?.type || '') !== pending.originalType ||
      (pending.originalId !== undefined && completeMessage?.id !== pending.originalId)
    ) {
      throw new Error('Rejected WebRTC chunks whose envelope metadata did not match the message');
    }
    await this.onMessageHandler(completeMessage);
  }

  /**
   * Start background cleanup task for timed-out chunks
   * Prevents memory leaks from incomplete message transfers
   */
  private startChunkCleanup(): void {
    this.chunkCleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [chunkId, pending] of this.pendingChunks.entries()) {
        const age = now - pending.timestamp;

        if (age >= WEBRTC_CONSTANTS.CHUNK_TIMEOUT_MS) {
          this.logger.warn('Chunk timeout - cleaning up incomplete message', {
            chunkId,
            originalType: pending.originalType,
            receivedChunks: pending.chunks.size,
            totalChunks: pending.totalChunks,
            ageMs: age,
          });

          // Send error response to client if we have a requestId
          if (pending.originalId) {
            void this.sendMessage({
              type: 'error',
              requestId: pending.originalId,
              error: 'Chunked message timeout',
              details: `Received ${pending.chunks.size}/${pending.totalChunks} chunks before timeout`,
            }).catch(sendError => {
              this.logger.warn('Could not send chunk timeout error', sendError);
            });
          }

          this.pendingChunks.delete(chunkId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.info(`Cleaned up ${cleanedCount} timed-out chunk message(s)`);
      }
    }, WEBRTC_CONSTANTS.CHUNK_CLEANUP_INTERVAL_MS);
    this.chunkCleanupInterval.unref?.();
  }

  disconnect(): void {
    // Stop chunk cleanup interval
    if (this.chunkCleanupInterval) {
      clearInterval(this.chunkCleanupInterval);
      this.chunkCleanupInterval = null;
    }

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.setConnected(false);
    this.clearDisconnectGraceTimer();
    this.pendingChunks.clear();
    this.logger.info('WebRTC peer disconnected');
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  private setConnected(connected: boolean, reportInitialTerminalState = false): void {
    if (
      this.isConnected === connected &&
      (!reportInitialTerminalState || this.hasReportedConnectionState)
    ) {
      return;
    }
    this.isConnected = connected;
    this.hasReportedConnectionState = true;
    try {
      this.onConnectionStateChange?.(connected);
    } catch (error) {
      this.logger.warn('WebRTC connection state callback failed', error);
    }
  }

  private scheduleDisconnectGrace(): void {
    if (this.disconnectGraceTimer) return;
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      const iceState = this.peerConnection?.iceConnectionState;
      const connectionState = this.peerConnection?.connectionState;
      if (iceState === 'disconnected' || connectionState === 'disconnected') {
        this.logger.warn('[WebRTC] Transient disconnect did not recover within grace period');
        this.setConnected(false, true);
      }
    }, DISCONNECT_GRACE_MS);
    this.disconnectGraceTimer.unref?.();
  }

  private clearDisconnectGraceIfRecovered(): void {
    if (
      this.peerConnection?.iceConnectionState !== 'disconnected' &&
      this.peerConnection?.connectionState !== 'disconnected'
    ) {
      this.clearDisconnectGraceTimer();
    }
  }

  private clearDisconnectGraceTimer(): void {
    if (!this.disconnectGraceTimer) return;
    clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
  }
}
