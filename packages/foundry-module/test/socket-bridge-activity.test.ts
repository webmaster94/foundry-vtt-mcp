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

  onopen: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  send = vi.fn();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.();
  }

  remoteClose(wasClean = true): void {
    this.onclose?.({ reason: 'server restart', wasClean });
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

  it('tracks asynchronous job completion until scene work finishes', async () => {
    const order: string[] = [];
    const bridge = new SocketBridge(config, {
      onQueryStart: () => order.push('start'),
      onQueryEnd: () => order.push('end'),
    });
    (bridge as any).handleJobCompleted = vi.fn(async () => {
      order.push('job');
      await Promise.resolve();
      order.push('finished');
    });

    await (bridge as any).handleMessage({
      type: 'job-completed',
      data: { jobId: 'map-1' },
    });

    expect(order).toEqual(['start', 'job', 'finished', 'end']);
  });

  it('treats map-generation progress as bridge activity', async () => {
    const order: string[] = [];
    const bridge = new SocketBridge(config, {
      onQueryStart: () => order.push('start'),
      onQueryEnd: () => order.push('end'),
    });
    (bridge as any).handleProgressUpdate = vi.fn(() => order.push('progress'));

    await (bridge as any).handleMessage({
      type: 'map-generation-progress',
      data: { jobId: 'map-1', progress: 50 },
    });

    expect(order).toEqual(['start', 'progress', 'end']);
  });
});

describe('SocketBridge reconnect ownership', () => {
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
