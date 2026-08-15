import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebRTCConnection, type WebRTCConfig } from '../src/webrtc-connection.js';

const config: WebRTCConfig = {
  serverHost: 'localhost',
  serverPort: 31415,
  namespace: '/foundry-mcp',
  stunServers: [],
  connectionTimeout: 1,
  debugLogging: false,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebRTCConnection', () => {
  it('becomes ready only when a fully reliable ordered data channel opens', async () => {
    let dataChannelOptions: RTCDataChannelInit | undefined;
    const dataChannel: Record<string, any> = {
      readyState: 'connecting',
      close: vi.fn(),
      send: vi.fn(),
    };

    class FakeRTCPeerConnection {
      iceGatheringState = 'complete';
      iceConnectionState = 'new';
      connectionState = 'new';
      localDescription: RTCSessionDescriptionInit = { type: 'offer', sdp: 'offer' };
      onicegatheringstatechange: (() => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;

      createDataChannel(_label: string, options?: RTCDataChannelInit): RTCDataChannel {
        dataChannelOptions = options;
        return dataChannel as RTCDataChannel;
      }
      async createOffer(): Promise<RTCSessionDescriptionInit> {
        return this.localDescription;
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
      close(): void {}
    }

    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
    vi.stubGlobal(
      'RTCSessionDescription',
      class {
        constructor(value: RTCSessionDescriptionInit) {
          Object.assign(this, value);
        }
      }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answer: { type: 'answer', sdp: 'answer' } }),
      })
    );

    const states: boolean[] = [];
    const connection = new WebRTCConnection(config, connected => states.push(connected));
    await connection.connect(async () => {});

    expect(dataChannelOptions).toEqual({ ordered: true });
    expect(connection.isConnected()).toBe(false);

    dataChannel.readyState = 'open';
    dataChannel.onopen();
    expect(connection.isConnected()).toBe(true);
    expect(states).toEqual([true]);
    connection.disconnect();
  });

  it('throws when a message cannot be put on an open data channel', async () => {
    const connection = new WebRTCConnection(config);
    await expect(connection.sendMessage({ type: 'ping' })).rejects.toThrow(
      'data channel is not open'
    );
  });

  it('honors the configured WebRTC signaling host from an HTTPS world', async () => {
    vi.stubGlobal('window', { location: { protocol: 'https:' } });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answer: { type: 'answer', sdp: 'answer' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'RTCSessionDescription',
      class {
        constructor(value: RTCSessionDescriptionInit) {
          Object.assign(this, value);
        }
      }
    );

    const connection = new WebRTCConnection({ ...config, serverHost: '192.168.1.50' });
    await (connection as any).sendSignalingOffer({ type: 'offer', sdp: 'offer' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.50:31416/webrtc-offer',
      expect.objectContaining({ method: 'POST', targetAddressSpace: 'local' })
    );
  });

  it('handles aggregate peer failure and lets a transient disconnect recover', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { protocol: 'http:' },
      setTimeout,
      clearTimeout,
    });
    const states: boolean[] = [];
    const connection = new WebRTCConnection(config, connected => states.push(connected));
    const peerConnection: Record<string, any> = {
      iceConnectionState: 'connected',
      connectionState: 'connected',
      close: vi.fn(),
    };
    const dataChannel: Record<string, any> = {
      readyState: 'open',
      close: vi.fn(),
      send: vi.fn(),
    };
    (connection as any).peerConnection = peerConnection;
    (connection as any).dataChannel = dataChannel;
    (connection as any).setupDataChannelHandlers();
    (connection as any).setupPeerConnectionHandlers();
    dataChannel.onopen();

    peerConnection.connectionState = 'disconnected';
    peerConnection.onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(1_000);
    peerConnection.connectionState = 'connected';
    peerConnection.onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.isConnected()).toBe(true);

    peerConnection.connectionState = 'failed';
    peerConnection.onconnectionstatechange();
    expect(connection.isConnected()).toBe(false);
    expect(states).toEqual([true, false]);
    connection.disconnect();
  });

  it('rejects oversized chunks and expires incomplete reassembly state', async () => {
    let cleanupInterval: (() => void) | undefined;
    vi.stubGlobal('window', {
      setInterval: (handler: () => void) => {
        cleanupInterval = handler;
        return 1;
      },
      location: { protocol: 'http:' },
    });
    vi.stubGlobal('clearInterval', vi.fn());
    const connection = new WebRTCConnection(config);

    await expect(
      (connection as any).handleChunkedMessage({
        type: 'chunked-message',
        chunkId: 'oversized',
        chunkIndex: 0,
        totalChunks: 1,
        chunk: 'eA==',
        encoding: 'base64',
        byteLength: 1,
        totalBytes: 16 * 1024 * 1024 + 1,
        originalType: 'mcp-response',
      })
    ).rejects.toThrow('malformed or oversized');
    expect((connection as any).pendingChunks.size).toBe(0);

    await (connection as any).handleChunkedMessage({
      type: 'chunked-message',
      chunkId: 'incomplete',
      chunkIndex: 0,
      totalChunks: 2,
      chunk: 'eA==',
      encoding: 'base64',
      byteLength: 1,
      totalBytes: 36 * 1024 + 1,
      originalType: 'mcp-response',
    });
    expect((connection as any).pendingChunks.size).toBe(1);
    expect(cleanupInterval).toBeTypeOf('function');
    const pending = [...(connection as any).pendingChunks.values()][0];
    vi.spyOn(Date, 'now').mockReturnValue(pending.timestamp + 30_001);
    cleanupInterval!();
    expect((connection as any).pendingChunks.size).toBe(0);
    connection.disconnect();
  });

  it('uses chunk inactivity rather than total transfer age for cleanup', async () => {
    let cleanupInterval: (() => void) | undefined;
    vi.stubGlobal('window', {
      setInterval: (handler: () => void) => {
        cleanupInterval = handler;
        return 1;
      },
      location: { protocol: 'http:' },
    });
    vi.stubGlobal('clearInterval', vi.fn());
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const connection = new WebRTCConnection(config);
    const base = {
      type: 'chunked-message',
      chunkId: 'slow-progress',
      totalChunks: 3,
      chunk: 'eA==',
      encoding: 'base64',
      byteLength: 1,
      totalBytes: 72 * 1024 + 1,
      originalType: 'mcp-response',
    };

    await (connection as any).handleChunkedMessage({ ...base, chunkIndex: 0 });
    now.mockReturnValue(21_000);
    await (connection as any).handleChunkedMessage({ ...base, chunkIndex: 1 });
    now.mockReturnValue(36_000);
    cleanupInterval!();
    expect((connection as any).pendingChunks.has('slow-progress')).toBe(true);

    now.mockReturnValue(51_001);
    cleanupInterval!();
    expect((connection as any).pendingChunks.has('slow-progress')).toBe(false);
    connection.disconnect();
  });
});
