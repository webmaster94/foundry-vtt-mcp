import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import { Logger } from './logger.js';
import { WebRTCPeer } from './webrtc-peer.js';

function logger(): Logger {
  return {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as unknown as Logger;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WebRTCPeer readiness', () => {
  it('does not report ready until the data channel is open and propagates send failures', async () => {
    const states: boolean[] = [];
    const peer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async () => {},
      onConnectionStateChange: connected => states.push(connected),
    });
    const peerConnection: Record<string, any> = {
      connectionState: 'connected',
      iceGatheringStateChange: { subscribe: vi.fn() },
      iceConnectionStateChange: { subscribe: vi.fn() },
      close: vi.fn(),
    };
    (peer as any).peerConnection = peerConnection;
    (peer as any).setupPeerConnectionHandlers();
    peerConnection.onconnectionstatechange();
    expect(peer.getIsConnected()).toBe(false);

    const dataChannel: Record<string, any> = {
      readyState: 'connecting',
      send: vi.fn(),
      close: vi.fn(),
    };
    (peer as any).dataChannel = dataChannel;
    (peer as any).setupDataChannelHandlers();
    await expect(peer.sendMessage({ type: 'ping' })).rejects.toThrow('data channel is not open');

    dataChannel.readyState = 'open';
    dataChannel.onopen();
    expect(peer.getIsConnected()).toBe(true);
    expect(states).toEqual([true]);

    dataChannel.send.mockImplementation(() => {
      throw new Error('SCTP send failed');
    });
    await expect(peer.sendMessage({ type: 'ping' })).rejects.toThrow('SCTP send failed');
    peer.disconnect();
    expect(states).toEqual([true, false]);
  });

  it('rejects malformed chunks and cleans incomplete bounded reassembly state', async () => {
    vi.useFakeTimers();
    const peer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async () => {},
    });

    await expect(
      (peer as any).handleChunkedMessage({
        type: 'chunked-message',
        chunkId: 'oversized',
        chunkIndex: 0,
        totalChunks: 1,
        chunk: 'eA==',
        encoding: 'base64',
        byteLength: 1,
        totalBytes: 16 * 1024 * 1024 + 1,
        originalType: 'mcp-query',
      })
    ).rejects.toThrow('malformed or oversized');
    expect((peer as any).pendingChunks.size).toBe(0);

    await (peer as any).handleChunkedMessage({
      type: 'chunked-message',
      chunkId: 'incomplete',
      chunkIndex: 0,
      totalChunks: 2,
      chunk: 'eA==',
      encoding: 'base64',
      byteLength: 1,
      totalBytes: 36 * 1024 + 1,
      originalType: 'mcp-query',
    });
    expect((peer as any).pendingChunks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect((peer as any).pendingChunks.size).toBe(0);
    peer.disconnect();
    vi.useRealTimers();
  });

  it('keeps a slow transfer while valid chunks continue to make progress', async () => {
    vi.useFakeTimers();
    const peer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async () => {},
    });
    const base = {
      type: 'chunked-message',
      chunkId: 'slow-progress',
      totalChunks: 3,
      chunk: 'eA==',
      encoding: 'base64',
      byteLength: 1,
      totalBytes: 72 * 1024 + 1,
      originalType: 'mcp-query',
    };

    await (peer as any).handleChunkedMessage({ ...base, chunkIndex: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    await (peer as any).handleChunkedMessage({ ...base, chunkIndex: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect((peer as any).pendingChunks.has('slow-progress')).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    expect((peer as any).pendingChunks.has('slow-progress')).toBe(false);
    peer.disconnect();
  });

  it('waits for data-channel backpressure to drain before sending', async () => {
    vi.useFakeTimers();
    const peer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async () => {},
    });
    const dataChannel: Record<string, any> = {
      readyState: 'open',
      bufferedAmount: 600 * 1024,
      bufferedAmountLowThreshold: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    (peer as any).dataChannel = dataChannel;
    (peer as any).setupDataChannelHandlers();

    const sending = peer.sendMessage({ type: 'ping' });
    await Promise.resolve();
    expect(dataChannel.send).not.toHaveBeenCalled();
    dataChannel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);
    await sending;

    expect(dataChannel.send).toHaveBeenCalledOnce();
    peer.disconnect();
  });

  it('never dispatches a queued message after its query is cancelled', async () => {
    vi.useFakeTimers();
    const peer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async () => {},
    });
    const dataChannel: Record<string, any> = {
      readyState: 'open',
      bufferedAmount: 600 * 1024,
      bufferedAmountLowThreshold: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    (peer as any).dataChannel = dataChannel;
    (peer as any).setupDataChannelHandlers();

    const first = peer.sendMessage({ type: 'first' });
    const abortController = new AbortController();
    const secondAttempt = vi.fn();
    const second = peer.sendMessage(
      { type: 'mcp-query', id: 'timed-out-write' },
      { signal: abortController.signal, onSendAttempt: secondAttempt }
    );
    await Promise.resolve();
    abortController.abort(new Error('query timed out'));
    dataChannel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);

    await first;
    await expect(second).rejects.toThrow('query timed out');
    expect(secondAttempt).not.toHaveBeenCalled();
    expect(dataChannel.send).toHaveBeenCalledOnce();
    expect(dataChannel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'first' }));
    peer.disconnect();
  });

  it('allows a transient disconnected ICE state to recover within grace', async () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    let handleIceState: ((state: string) => void) | undefined;
    const peer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async () => {},
      onConnectionStateChange: connected => states.push(connected),
    });
    const peerConnection: Record<string, any> = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      iceGatheringStateChange: { subscribe: vi.fn() },
      iceConnectionStateChange: {
        subscribe: vi.fn((handler: (state: string) => void) => {
          handleIceState = handler;
        }),
      },
      close: vi.fn(),
    };
    (peer as any).peerConnection = peerConnection;
    (peer as any).setupPeerConnectionHandlers();
    const dataChannel: Record<string, any> = {
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
    };
    (peer as any).dataChannel = dataChannel;
    (peer as any).setupDataChannelHandlers();
    dataChannel.onopen();

    peerConnection.iceConnectionState = 'disconnected';
    handleIceState?.('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(peer.getIsConnected()).toBe(true);

    peerConnection.iceConnectionState = 'connected';
    handleIceState?.('connected');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peer.getIsConnected()).toBe(true);
    expect(states).toEqual([true]);
    peer.disconnect();
  });
});
