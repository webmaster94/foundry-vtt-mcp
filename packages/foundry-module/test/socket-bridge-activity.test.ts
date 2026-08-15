import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketBridge, type BridgeConfig } from '../src/socket-bridge.js';

const config: BridgeConfig = {
  enabled: true,
  serverHost: 'localhost',
  serverPort: 31415,
  namespace: '/foundry-mcp',
  reconnectAttempts: 5,
  reconnectDelay: 1000,
  connectionTimeout: 10,
  debugLogging: false,
  connectionType: 'websocket',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
  });
  send = vi.fn();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  remoteClose(wasClean = true, code = 1000, reason = 'server restart'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
  }

  fail(): void {
    this.onerror?.(new Error('connection failed'));
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('SocketBridge query activity callbacks', () => {
  it('wraps a real MCP query and starts capture before its handler runs', async () => {
    const order: string[] = [];
    vi.stubGlobal('CONFIG', {
      queries: {
        'foundry-mcp-bridge.test': async () => {
          order.push('handler');
          return { ok: true };
        },
      },
    });

    const bridge = new SocketBridge(config, {
      onQueryStart: () => order.push('start'),
      onQueryEnd: () => order.push('end'),
    });

    await (bridge as any).handleMessage({
      type: 'mcp-query',
      id: 'query-1',
      data: { method: 'foundry-mcp-bridge.test', data: {} },
    });

    expect(order).toEqual(['start', 'handler', 'end']);
  });

  it('ends activity when query execution fails', async () => {
    const order: string[] = [];
    vi.stubGlobal('CONFIG', {
      queries: {
        'foundry-mcp-bridge.fail': async () => {
          order.push('handler');
          throw new Error('expected failure');
        },
      },
    });

    const bridge = new SocketBridge(config, {
      onQueryStart: () => order.push('start'),
      onQueryEnd: () => order.push('end'),
    });

    await (bridge as any).handleMessage({
      type: 'mcp-query',
      id: 'query-2',
      data: { method: 'foundry-mcp-bridge.fail', data: {} },
    });

    expect(order).toEqual(['start', 'handler', 'end']);
  });

  it('does not treat transport pings as MCP activity', async () => {
    const onQueryStart = vi.fn();
    const onQueryEnd = vi.fn();
    const bridge = new SocketBridge(config, { onQueryStart, onQueryEnd });

    await (bridge as any).handleMessage({ type: 'ping', id: 'ping-1' });

    expect(onQueryStart).not.toHaveBeenCalled();
    expect(onQueryEnd).not.toHaveBeenCalled();
  });

  it('reports capture status without waking capture', async () => {
    const onQueryStart = vi.fn();
    const onQueryEnd = vi.fn();
    vi.stubGlobal('CONFIG', {
      queries: {
        'foundry-mcp-bridge.getBrowserConsoleStatus': () => ({ active: false }),
      },
    });
    const bridge = new SocketBridge(config, { onQueryStart, onQueryEnd });

    await (bridge as any).handleMessage({
      type: 'mcp-query',
      id: 'status-1',
      data: { method: 'foundry-mcp-bridge.getBrowserConsoleStatus', data: {} },
    });

    expect(onQueryStart).not.toHaveBeenCalled();
    expect(onQueryEnd).not.toHaveBeenCalled();
  });

  it('does not treat the MCP health query as bridge activity', async () => {
    const onQueryStart = vi.fn();
    const onQueryEnd = vi.fn();
    vi.stubGlobal('CONFIG', {
      queries: {
        'foundry-mcp-bridge.ping': () => ({ success: true }),
      },
    });
    const bridge = new SocketBridge(config, { onQueryStart, onQueryEnd });

    await (bridge as any).handleMessage({
      type: 'mcp-query',
      id: 'health-1',
      data: { method: 'foundry-mcp-bridge.ping', data: {} },
    });

    expect(onQueryStart).not.toHaveBeenCalled();
    expect(onQueryEnd).not.toHaveBeenCalled();
  });
});

describe('SocketBridge reconnect ownership', () => {
  it('uses WSS on HTTPS while preserving the configured port and encoded auth token', async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'https:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({
      ...config,
      serverHost: 'bridge.example.test',
      serverPort: 42424,
      authToken: 'a b&c',
    });

    const connecting = bridge.connect();
    expect(FakeWebSocket.instances[0].url).toBe(
      'wss://bridge.example.test:42424/foundry-mcp?token=a%20b%26c'
    );
    FakeWebSocket.instances[0].open();
    await connecting;
    bridge.disconnect();
  });

  it('fails fast for explicit HTTPS loopback WebSocket instead of changing transports', async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'https:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, serverHost: 'localhost' });

    await expect(bridge.connect()).rejects.toThrow('select Auto or WebRTC');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(bridge.getConnectionState()).toBe('disconnected');
    bridge.disconnect();
  });

  it('allows explicit HTTP loopback WebSocket on port 65535', async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, serverPort: 65535 });

    const connecting = bridge.connect();
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:65535/foundry-mcp');
    FakeWebSocket.instances[0].open();
    await connecting;
    bridge.disconnect();
  });

  it.each(['auto', 'webrtc'] as const)(
    'rejects port 65535 before opening an %s transport',
    async connectionType => {
      FakeWebSocket.instances = [];
      vi.stubGlobal('window', { location: { protocol: 'http:' } });
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const bridge = new SocketBridge({ ...config, connectionType, serverPort: 65535 });

      await expect(bridge.connect()).rejects.toThrow('at most 65534');
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(bridge.getConnectionState()).toBe('disconnected');
      bridge.disconnect();
    }
  );

  it('reconnects after a remote clean close', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const initialConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await initialConnect;
    FakeWebSocket.instances[0].remoteClose(true);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(FakeWebSocket.instances).toHaveLength(2);
    bridge.disconnect();
  });

  it('wakes a scheduled reconnect immediately without creating a second retry owner', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const initialConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await initialConnect;
    FakeWebSocket.instances[0].remoteClose();

    const recovered = bridge.reconnectNow();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    await recovered;
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    bridge.disconnect();
  });

  it('backs off sockets that open but are rejected before any application message', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const firstConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await firstConnect;
    FakeWebSocket.instances[0].remoteClose();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].remoteClose();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    bridge.disconnect();
  });

  it('keeps duplicate-owner standby state until an accepted application message arrives', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const initialConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await initialConnect;
    FakeWebSocket.instances[0].remoteClose(
      true,
      4009,
      'Another Foundry module connection is active'
    );
    expect(bridge.getConnectionInfo().standbyBecauseOwnerActive).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.instances[1].open();
    expect(bridge.getConnectionInfo()).toMatchObject({
      standbyBecauseOwnerActive: true,
      state: 'connected',
    });

    FakeWebSocket.instances[1].receive({ type: 'ping', id: 'ownership-proof' });
    expect(bridge.getConnectionInfo().standbyBecauseOwnerActive).toBe(false);
    bridge.disconnect();
  });

  it('preserves standby ownership evidence across transient retry failures', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const initialConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await initialConnect;
    FakeWebSocket.instances[0].remoteClose(
      true,
      4009,
      'Another Foundry module connection is active'
    );
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    FakeWebSocket.instances[1].fail();

    expect(bridge.getConnectionInfo().standbyBecauseOwnerActive).toBe(true);
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    FakeWebSocket.instances[2].open();
    FakeWebSocket.instances[2].remoteClose(false, 1006, 'network lost');
    expect(bridge.getConnectionInfo().standbyBecauseOwnerActive).toBe(true);
    bridge.disconnect();
  });

  it('refreshes a standby retry in place with the latest connection config', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const initialConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await initialConnect;
    FakeWebSocket.instances[0].remoteClose(
      true,
      4009,
      'Another Foundry module connection is active'
    );

    bridge.updateConfig({
      ...config,
      serverPort: 42424,
      authToken: 'new token',
      autoReconnect: true,
    });
    expect(bridge.getConnectionInfo()).toMatchObject({
      standbyBecauseOwnerActive: true,
      config: { port: 42424 },
    });
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(FakeWebSocket.instances[1].url).toBe(
      'ws://localhost:42424/foundry-mcp?token=new%20token'
    );
    bridge.disconnect();
  });

  it('cancels a standby retry when refreshed auto-reconnect is disabled', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bridge = new SocketBridge({ ...config, autoReconnect: true });

    const initialConnect = bridge.connect();
    FakeWebSocket.instances[0].open();
    await initialConnect;
    FakeWebSocket.instances[0].remoteClose(
      true,
      4009,
      'Another Foundry module connection is active'
    );
    bridge.updateConfig({ ...config, autoReconnect: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(bridge.getConnectionState()).toBe('disconnected');
    bridge.disconnect();
  });

  it('does not reconnect after disposal or when auto-reconnect is disabled', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const disabledBridge = new SocketBridge({ ...config, autoReconnect: false });
    const disabledConnect = disabledBridge.connect();
    FakeWebSocket.instances[0].open();
    await disabledConnect;
    FakeWebSocket.instances[0].remoteClose(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const disposedBridge = new SocketBridge({ ...config, autoReconnect: true });
    const disposedConnect = disposedBridge.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    disposedBridge.disconnect();
    await expect(disposedConnect).rejects.toThrow('disposed');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
