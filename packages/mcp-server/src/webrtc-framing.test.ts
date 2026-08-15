import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebRTCConnection, type WebRTCConfig } from '../../foundry-module/src/webrtc-connection.js';
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

function channel(): Record<string, any> {
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: vi.fn(),
    close() {
      this.readyState = 'closed';
    },
  };
}

const browserConfig: WebRTCConfig = {
  serverHost: 'localhost',
  serverPort: 31415,
  namespace: '/foundry-mcp',
  stunServers: [],
  connectionTimeout: 1,
  debugLogging: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('symmetric WebRTC framing', () => {
  it('round-trips a large Unicode payload in both directions within SCTP frame limits', async () => {
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval.bind(globalThis),
      location: { protocol: 'http:' },
    });

    let nodeReceived: any;
    let browserReceived: any;
    const nodePeer = new WebRTCPeer({
      config: config.foundry.webrtc,
      logger: logger(),
      onMessage: async message => {
        nodeReceived = message;
      },
    });
    const browserPeer = new WebRTCConnection(browserConfig);
    const nodeChannel = channel();
    const browserChannel = channel();
    const nodeToBrowser: Promise<void>[] = [];
    const browserToNode: Promise<void>[] = [];

    (nodePeer as any).dataChannel = nodeChannel;
    (nodePeer as any).setupDataChannelHandlers();
    (browserPeer as any).dataChannel = browserChannel;
    (browserPeer as any).messageHandler = async (message: any) => {
      browserReceived = message;
    };
    (browserPeer as any).setupDataChannelHandlers();

    nodeChannel.send = vi.fn((data: string) => {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(65_536);
      nodeToBrowser.push(Promise.resolve(browserChannel.onmessage({ data })));
    });
    browserChannel.send = vi.fn((data: string) => {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(65_536);
      browserToNode.push(Promise.resolve(nodeChannel.onmessage({ data })));
    });

    const message = {
      type: 'mcp-response',
      id: 'unicode-large',
      data: { text: '🎲漢字—Foundry—'.repeat(20_000) },
    };
    await nodePeer.sendMessage(message);
    await Promise.all(nodeToBrowser);
    expect(browserReceived).toEqual(message);
    expect(nodeChannel.send.mock.calls.length).toBeGreaterThan(1);

    await browserPeer.sendMessage(message);
    await Promise.all(browserToNode);
    expect(nodeReceived).toEqual(message);
    expect(browserChannel.send.mock.calls.length).toBeGreaterThan(1);

    nodePeer.disconnect();
    browserPeer.disconnect();
  });
});
