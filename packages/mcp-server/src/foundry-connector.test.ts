import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { config } from './config.js';
import {
  FoundryConnector,
  QueryOutcomeUnknownError,
  QueryTimeoutError,
} from './foundry-connector.js';
import { Logger } from './logger.js';

const connectors: FoundryConnector[] = [];
const sockets: WebSocket[] = [];

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

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(connectors.splice(0).map(connector => connector.stop()));
  vi.restoreAllMocks();
});

describe('FoundryConnector WebSocket lifecycle', () => {
  it.each(['websocket', 'webrtc'] as const)(
    'refuses an unauthenticated remote %s listener before binding',
    async connectionType => {
      const connector = new FoundryConnector({
        config: {
          ...config.foundry,
          port: 32199,
          connectionType,
          remoteMode: true,
          authToken: undefined,
        },
        logger: logger(),
      });

      await expect(connector.start()).rejects.toThrow(
        'remoteMode requires an authToken of at least 16 characters'
      );
      expect(connector.getConnectionInfo().started).toBe(false);
    }
  );

  it('rejects a duplicate owner explicitly and accepts a retry after the owner closes', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        namespace: '/duplicate-test',
        connectionType: 'websocket',
        authToken: 'shared secret',
      },
      logger: logger(),
    });
    connectors.push(connector);
    await connector.start();
    const port = connector.getConnectionInfo().config.port as number;
    const url = `ws://127.0.0.1:${port}/duplicate-test?token=${encodeURIComponent('shared secret')}`;

    const owner = new WebSocket(url);
    sockets.push(owner);
    await waitForOpen(owner);
    await waitUntil(() => connector.isConnected());

    const eventHandler = vi.fn();
    connector.onBridgeEvent = eventHandler;
    owner.send(JSON.stringify({ type: 'bridge-event', event: { type: 'actor.created' } }));
    await waitUntil(() => eventHandler.mock.calls.length === 1);
    expect(eventHandler).toHaveBeenCalledWith({ type: 'actor.created' });

    const duplicate = new WebSocket(url);
    sockets.push(duplicate);
    const duplicateClosed = waitForClose(duplicate);
    await waitForOpen(duplicate);
    await expect(duplicateClosed).resolves.toMatchObject({
      code: 4009,
      reason: 'Another Foundry module connection is active',
    });
    expect(connector.isConnected()).toBe(true);

    const ownerClosed = waitForClose(owner);
    owner.close();
    await ownerClosed;
    await waitUntil(() => !connector.isConnected());

    const replacement = new WebSocket(url);
    sockets.push(replacement);
    await waitForOpen(replacement);
    await waitUntil(() => connector.isConnected());
  });

  it('preserves transport-edge authentication', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        namespace: '/auth-test',
        connectionType: 'websocket',
        authToken: 'correct-token',
      },
      logger: logger(),
    });
    connectors.push(connector);
    await connector.start();
    const port = connector.getConnectionInfo().config.port as number;
    const invalid = new WebSocket(`ws://127.0.0.1:${port}/auth-test?token=wrong-token`);
    sockets.push(invalid);

    await expect(waitForOpen(invalid)).rejects.toThrow();
    expect(connector.isConnected()).toBe(false);
  });

  it('keeps a protocol-live WebSocket connected while background JavaScript app pongs pause', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        namespace: '/liveness-test',
        connectionType: 'websocket',
      },
      logger: logger(),
      heartbeatIntervalMs: 10,
      staleTimeoutMs: 35,
      queryTimeoutMs: 1_000,
    });
    connectors.push(connector);
    await connector.start();
    const port = connector.getConnectionInfo().config.port as number;

    // ws automatically answers protocol-level pings. Deliberately do not
    // answer JSON application pings, matching a throttled background tab.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/liveness-test`);
    sockets.push(socket);
    await waitForOpen(socket);
    await waitUntil(() => connector.isConnected());

    await new Promise(resolve => setTimeout(resolve, 120));
    expect(connector.isConnected()).toBe(true);
    expect(connector.getLastDisconnectAt()).toBeNull();
  });

  it('promotes a healthy duplicate when the protocol-live owner has frozen JavaScript', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        namespace: '/frozen-owner-test',
        connectionType: 'websocket',
      },
      logger: logger(),
      heartbeatIntervalMs: 10,
      duplicateTakeoverStaleMs: 50,
    });
    connectors.push(connector);
    await connector.start();
    const port = connector.getConnectionInfo().config.port as number;
    const owner = new WebSocket(`ws://127.0.0.1:${port}/frozen-owner-test`);
    sockets.push(owner);
    await waitForOpen(owner);
    await waitUntil(() => connector.isConnected());

    // ws keeps answering native pings, but this client deliberately never
    // answers the JSON application heartbeat, matching a frozen page.
    await new Promise(resolve => setTimeout(resolve, 75));
    const ownerClosed = waitForClose(owner);
    const replacement = new WebSocket(`ws://127.0.0.1:${port}/frozen-owner-test`);
    sockets.push(replacement);
    await waitForOpen(replacement);
    await expect(ownerClosed).resolves.toMatchObject({ code: 4010 });
    await waitUntil(() => connector.isConnected());
    const eventHandler = vi.fn();
    connector.onBridgeEvent = eventHandler;
    replacement.send(JSON.stringify({ type: 'bridge-event', event: { type: 'healthy-owner' } }));
    await waitUntil(() => eventHandler.mock.calls.length === 1);
    expect(eventHandler).toHaveBeenCalledWith({ type: 'healthy-owner' });
  });

  it('still tears down an application-stale WebRTC channel', async () => {
    const connector = new FoundryConnector({
      config: config.foundry,
      logger: logger(),
      heartbeatIntervalMs: 10,
      staleTimeoutMs: 35,
    });
    const peer = { getIsConnected: () => true, disconnect: vi.fn() };
    (connector as any).webrtcPeer = peer;
    (connector as any).activeConnectionType = 'webrtc';
    (connector as any).lastApplicationSeenAt = Date.now() - 100;

    await (connector as any).performHeartbeat(0);

    expect(peer.disconnect).toHaveBeenCalledOnce();
    expect(connector.getLastDisconnectAt()).not.toBeNull();
  });

  it('marks a sent query indeterminate when the transport closes before its response', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        namespace: '/unknown-outcome-test',
        connectionType: 'websocket',
      },
      logger: logger(),
    });
    connectors.push(connector);
    await connector.start();
    const port = connector.getConnectionInfo().config.port as number;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/unknown-outcome-test`);
    sockets.push(socket);
    await waitForOpen(socket);
    await waitUntil(() => connector.isConnected());
    socket.once('message', () => socket.close());

    await expect(connector.query('foundry-mcp-bridge.createDocument', {})).rejects.toBeInstanceOf(
      QueryOutcomeUnknownError
    );
  });

  it('marks a query indeterminate when its send fails after actual dispatch begins', async () => {
    const connector = new FoundryConnector({ config: config.foundry, logger: logger() });
    const peer = {
      getIsConnected: () => true,
      sendMessage: vi.fn(async (_message: any, options: { onSendAttempt?: () => void } = {}) => {
        options.onSendAttempt?.();
        throw new Error('send failed after dispatch');
      }),
    };
    (connector as any).webrtcPeer = peer;
    (connector as any).activeConnectionType = 'webrtc';

    await expect(connector.query('foundry-mcp-bridge.createDocument', {})).rejects.toBeInstanceOf(
      QueryOutcomeUnknownError
    );
    expect((connector as any).pendingQueries.size).toBe(0);
  });

  it('preserves a send failure that occurs before actual dispatch begins', async () => {
    const connector = new FoundryConnector({ config: config.foundry, logger: logger() });
    const preDispatchError = new Error('send failed before dispatch');
    const peer = {
      getIsConnected: () => true,
      sendMessage: vi.fn(async () => {
        throw preDispatchError;
      }),
    };
    (connector as any).webrtcPeer = peer;
    (connector as any).activeConnectionType = 'webrtc';

    await expect(connector.query('foundry-mcp-bridge.createDocument', {})).rejects.toBe(
      preDispatchError
    );
    expect((connector as any).pendingQueries.size).toBe(0);
  });

  it('aborts a queued write before dispatch when its query deadline expires', async () => {
    vi.useFakeTimers();
    const connector = new FoundryConnector({
      config: config.foundry,
      logger: logger(),
      queryTimeoutMs: 25,
    });
    const dispatched = vi.fn();
    const peer = {
      getIsConnected: () => true,
      sendMessage: vi.fn(
        async (
          message: any,
          options: { signal?: AbortSignal; onSendAttempt?: () => void } = {}
        ) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 100);
            options.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(options.signal?.reason);
              },
              { once: true }
            );
          });
          if (options.signal?.aborted) throw options.signal.reason;
          options.onSendAttempt?.();
          dispatched(message);
        }
      ),
      disconnect: vi.fn(),
    };
    (connector as any).webrtcPeer = peer;
    (connector as any).activeConnectionType = 'webrtc';

    const query = connector.query('foundry-mcp-bridge.createDocument', {});
    const rejection = expect(query).rejects.toBeInstanceOf(QueryTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatched).not.toHaveBeenCalled();
    expect((connector as any).pendingQueries.size).toBe(0);
    vi.useRealTimers();
  });

  it('uses process-unique query IDs and ignores a stale response from another connector', async () => {
    const connectorA = new FoundryConnector({
      config: config.foundry,
      logger: logger(),
      queryTimeoutMs: 1_000,
    });
    const connectorB = new FoundryConnector({
      config: config.foundry,
      logger: logger(),
      queryTimeoutMs: 1_000,
    });
    const sentA: any[] = [];
    const sentB: any[] = [];
    for (const [connector, sent] of [
      [connectorA, sentA],
      [connectorB, sentB],
    ] as const) {
      (connector as any).webrtcPeer = {
        getIsConnected: () => true,
        sendMessage: async (message: any, options: { onSendAttempt?: () => void } = {}) => {
          options.onSendAttempt?.();
          sent.push(message);
        },
      };
      (connector as any).activeConnectionType = 'webrtc';
    }

    const queryA = connectorA.query('foundry-mcp-bridge.listActors', {});
    const queryB = connectorB.query('foundry-mcp-bridge.listActors', {});
    await vi.waitFor(() => expect(sentA).toHaveLength(1));
    await vi.waitFor(() => expect(sentB).toHaveLength(1));
    expect(sentA[0].id).not.toBe(sentB[0].id);

    let connectorBSettled = false;
    void queryB.finally(() => {
      connectorBSettled = true;
    });
    await (connectorB as any).handleMessage({
      type: 'mcp-response',
      id: sentA[0].id,
      data: { success: true, data: 'stale' },
    });
    await Promise.resolve();
    expect(connectorBSettled).toBe(false);

    await (connectorA as any).handleMessage({
      type: 'mcp-response',
      id: sentA[0].id,
      data: { success: true, data: 'A' },
    });
    await (connectorB as any).handleMessage({
      type: 'mcp-response',
      id: sentB[0].id,
      data: { success: true, data: 'B' },
    });
    await expect(queryA).resolves.toBe('A');
    await expect(queryB).resolves.toBe('B');
  });

  it('rejects oversized unauthenticated WebRTC signaling bodies before parsing', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        connectionType: 'webrtc',
        remoteMode: false,
        authToken: 'required-token',
      },
      logger: logger(),
      webrtcSignalingPortOverride: 0,
    });
    connectors.push(connector);
    await connector.start();
    const signalingAddress = (connector as any).webrtcSignalingServer.address();

    const response = await fetch(
      `http://127.0.0.1:${signalingAddress.port as number}/webrtc-offer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(300 * 1024),
      }
    );

    expect(response.status).toBe(413);
  });

  it('lets an authenticated HTTP offer replace an application-frozen WebRTC owner', async () => {
    const connector = new FoundryConnector({
      config: {
        ...config.foundry,
        port: 0,
        connectionType: 'webrtc',
        remoteMode: false,
        authToken: 'required-token',
      },
      logger: logger(),
      duplicateTakeoverStaleMs: 50,
      webrtcSignalingPortOverride: 0,
    });
    connectors.push(connector);
    await connector.start();
    const oldPeer = { getIsConnected: () => true, disconnect: vi.fn() };
    (connector as any).webrtcPeer = oldPeer;
    (connector as any).activeConnectionType = 'webrtc';
    (connector as any).lastApplicationSeenAt = Date.now() - 100;
    const replacementPeer = {
      handleOffer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer' }),
      getIsConnected: () => false,
      disconnect: vi.fn(),
    };
    vi.spyOn(connector as any, 'createWebRTCPeer').mockImplementation(() => {
      (connector as any).webrtcPeer = replacementPeer;
      (connector as any).webrtcOfferStartedAt = Date.now();
      return replacementPeer;
    });
    const signalingAddress = (connector as any).webrtcSignalingServer.address();

    const response = await fetch(
      `http://127.0.0.1:${signalingAddress.port as number}/webrtc-offer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'required-token',
          offer: { type: 'offer', sdp: 'offer' },
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(oldPeer.disconnect).toHaveBeenCalledOnce();
    expect(replacementPeer.handleOffer).toHaveBeenCalledOnce();
    expect((connector as any).webrtcPeer).toBe(replacementPeer);
  });

  it('disposes a pending WebRTC peer even when stop follows a partial start', async () => {
    const connector = new FoundryConnector({ config: config.foundry, logger: logger() });
    const peer = { disconnect: vi.fn() };
    (connector as any).webrtcPeer = peer;

    await connector.stop();

    expect(peer.disconnect).toHaveBeenCalledOnce();
    expect((connector as any).webrtcPeer).toBeNull();
  });

  it('does not let a superseded WebRTC handshake dispose its replacement', () => {
    const connector = new FoundryConnector({ config: config.foundry, logger: logger() });
    const oldPeer = { disconnect: vi.fn() };
    const replacementPeer = { disconnect: vi.fn() };
    (connector as any).webrtcPeer = replacementPeer;

    (connector as any).disposeWebRTCPeer(oldPeer);

    expect(oldPeer.disconnect).toHaveBeenCalledOnce();
    expect(replacementPeer.disconnect).not.toHaveBeenCalled();
    expect((connector as any).webrtcPeer).toBe(replacementPeer);
  });

  it('clears WebRTC handshake age when an active data channel closes', () => {
    const connector = new FoundryConnector({ config: config.foundry, logger: logger() });
    const peer = { disconnect: vi.fn() };
    (connector as any).webrtcPeer = peer;
    (connector as any).activeConnectionType = 'webrtc';
    (connector as any).webrtcOfferStartedAt = Date.now();

    (connector as any).handleWebRTCConnectionState(peer, false);

    expect((connector as any).webrtcOfferStartedAt).toBe(0);
    expect(connector.getLastDisconnectAt()).not.toBeNull();
  });

  it('releases a failed pre-open WebRTC handshake for an immediate replacement offer', async () => {
    const connector = new FoundryConnector({ config: config.foundry, logger: logger() });
    const firstPeer = (connector as any).createWebRTCPeer();
    let handleIceState: ((state: string) => void) | undefined;
    const peerConnection: Record<string, any> = {
      connectionState: 'connecting',
      iceConnectionState: 'checking',
      iceGatheringStateChange: { subscribe: vi.fn() },
      iceConnectionStateChange: {
        subscribe: vi.fn((handler: (state: string) => void) => {
          handleIceState = handler;
        }),
      },
      close: vi.fn(),
    };
    (firstPeer as any).peerConnection = peerConnection;
    (firstPeer as any).setupPeerConnectionHandlers();

    peerConnection.iceConnectionState = 'failed';
    handleIceState?.('failed');

    expect((connector as any).webrtcPeer).toBeNull();
    expect((connector as any).webrtcOfferStartedAt).toBe(0);
    expect(peerConnection.close).toHaveBeenCalledOnce();

    const replacementPeer = (connector as any).createWebRTCPeer();
    expect((connector as any).webrtcPeer).toBe(replacementPeer);
    expect(replacementPeer).not.toBe(firstPeer);
    await connector.stop();
  });
});
