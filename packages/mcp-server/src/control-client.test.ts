import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendControlClient, type BackendControlClientOptions } from './control-client.js';

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
const clients: BackendControlClient[] = [];
const tempDirectories: string[] = [];

async function listen(
  handler: (request: any, socket: net.Socket) => void
): Promise<{ port: number; connections: () => number }> {
  let connectionCount = 0;
  const server = net.createServer(socket => {
    connectionCount += 1;
    sockets.push(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handler(JSON.parse(line), socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test listener');
  return { port: address.port, connections: () => connectionCount };
}

function client(
  port: number,
  options: Omit<BackendControlClientOptions, 'port' | 'logFile'> = {}
): BackendControlClient {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-control-client-test-'));
  tempDirectories.push(directory);
  const value = new BackendControlClient({
    port,
    spawnBackend: false,
    restartStaleBackend: false,
    ...options,
    logFile: path.join(directory, 'client.log'),
  });
  clients.push(value);
  return value;
}

afterEach(async () => {
  for (const value of clients.splice(0)) value.cleanup();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        })
    )
  );
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('BackendControlClient', () => {
  it('correlates concurrent fragmented JSON-lines responses over one connection', async () => {
    const requests: any[] = [];
    const listener = await listen((request, socket) => {
      requests.push(request);
      if (requests.length !== 2) return;
      const response = requests
        .reverse()
        .map(
          item =>
            JSON.stringify({
              id: item.id,
              result: {
                ok: true,
                pid: 42,
                version: '0.12.0',
                startedAt: '2026-01-01T00:00:00.000Z',
                entrySig: item.params.marker,
                instanceId: `instance-${item.params.marker}`,
                entryPath: '/app/backend.js',
              },
            }) + '\n'
        )
        .join('');
      const midpoint = Math.floor(response.length / 2);
      socket.write(response.slice(0, midpoint));
      setImmediate(() => socket.write(response.slice(midpoint)));
    });
    const control = client(listener.port);

    const [first, second] = await Promise.all([
      control.send('ping', { marker: 'one' } as any),
      control.send('ping', { marker: 'two' } as any),
    ]);

    expect(new Set([first.entrySig, second.entrySig])).toEqual(new Set(['one', 'two']));
    expect(listener.connections()).toBe(1);
  });

  it('turns protocol errors into rejected requests with the original message', async () => {
    const listener = await listen((request, socket) => {
      socket.write(
        JSON.stringify({ id: request.id, error: { message: 'profile does not exist' } }) + '\n'
      );
    });
    const control = client(listener.port);

    await expect(control.send('set_active_server', { name: 'missing' })).rejects.toThrow(
      'profile does not exist'
    );
  });

  it('supports bounded desktop requests without imposing a timeout on legacy tool calls', async () => {
    const listener = await listen(() => {
      // Deliberately leave the request pending.
    });
    const control = client(listener.port);

    await expect(control.send('ping', {}, { timeoutMs: 25 })).rejects.toThrow(
      'Timeout waiting for ping'
    );
  });

  it('rejects pending work promptly when the backend socket closes', async () => {
    const listener = await listen((_request, socket) => socket.destroy());
    const control = client(listener.port);

    await expect(control.send('ping', {})).rejects.toThrow('Backend disconnected');
  });

  it('waits for the stale instance to disappear before accepting its replacement', async () => {
    const backendPath = path.resolve('src/control-client.ts');
    const stat = fs.statSync(backendPath);
    const currentSig = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    let shutdowns = 0;
    let stalePolls = 0;
    let stalePollsRemaining = 2;
    const listener = await listen((request, socket) => {
      if (request.method === 'shutdown') {
        shutdowns += 1;
        socket.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\n');
        return;
      }
      if (request.method !== 'ping') return;
      const stale = shutdowns === 0 || stalePollsRemaining > 0;
      if (shutdowns > 0 && stale) {
        stalePolls += 1;
        stalePollsRemaining -= 1;
      }
      socket.write(
        JSON.stringify({
          id: request.id,
          result: {
            ok: true,
            pid: stale ? 41 : 42,
            version: '0.12.0',
            startedAt: stale ? 'old' : 'new',
            entrySig: stale ? 'stale-signature' : currentSig,
            instanceId: stale ? 'stale-instance' : 'replacement-instance',
            entryPath: backendPath,
          },
        }) + '\n'
      );
    });
    const control = client(listener.port, {
      backendPath,
      restartStaleBackend: true,
      stalePollIntervalMs: 5,
      staleShutdownTimeoutMs: 500,
    });

    await control.ensure();
    const replacement = await control.send('ping', {}, { timeoutMs: 500 });

    expect(replacement.instanceId).toBe('replacement-instance');
    expect(shutdowns).toBe(1);
    expect(stalePolls).toBeGreaterThan(0);
    expect(listener.connections()).toBeGreaterThan(1);
  });
});
