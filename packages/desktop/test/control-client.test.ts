import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendControlClient, BackendRpcError } from '../src/main/control-client.js';

interface TestRequest {
  id: string;
  method: string;
  params: unknown;
}

type TestReply =
  | { result: unknown }
  | { error: { message: string; code?: string } }
  | { raw: string };

const servers: net.Server[] = [];

async function startServer(
  handler: (request: TestRequest) => TestReply | Promise<TestReply>
): Promise<number> {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as TestRequest;
      void Promise.resolve(handler(request)).then(reply => {
        if ('raw' in reply) socket.end(reply.raw);
        else socket.end(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port');
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        })
    )
  );
});

describe('BackendControlClient', () => {
  it('frames typed JSON-lines requests and normalizes status rows', async () => {
    const methods: string[] = [];
    const port = await startServer(request => {
      methods.push(request.method);
      return {
        result: {
          protocolVersion: 1,
          backend: { pid: 7, version: '0.12.0', startedAt: 'now', entrySig: 'sig' },
          config: { path: 'foundry-servers.json', exists: true, source: 'file' },
          activeServer: 'forge',
          servers: [
            {
              name: 'forge',
              label: 'Forge',
              host: 'localhost',
              port: 31415,
              connectionType: 'webrtc',
              remoteMode: false,
              active: true,
              connected: true,
              connectionInfo: { transport: 'webrtc' },
              cachedCapabilities: null,
            },
          ],
        },
      };
    });
    const client = new BackendControlClient({ port, requestTimeoutMs: 1_000 });

    const status = await client.getStatus();
    expect(methods).toEqual(['get_status']);
    expect(status.activeServer).toBe('forge');
    expect(status.servers[0]).toMatchObject({ name: 'forge', connected: true });
  });

  it('falls back to legacy call_tool methods for an older daemon', async () => {
    const methods: string[] = [];
    const port = await startServer(request => {
      methods.push(request.method);
      if (request.method === 'get_status') {
        return { error: { message: 'Unknown method: get_status' } };
      }
      if (request.method === 'ping') {
        return { result: { ok: true, pid: 9, startedAt: 'then', entrySig: 'old' } };
      }
      return {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                activeServer: 'local',
                servers: [
                  {
                    name: 'local',
                    label: 'Local',
                    host: 'localhost',
                    port: 31415,
                    connectionType: 'auto',
                    remoteMode: false,
                    active: true,
                    connected: false,
                    connectionInfo: null,
                  },
                ],
              }),
            },
          ],
        },
      };
    });
    const client = new BackendControlClient({ port, requestTimeoutMs: 1_000 });

    const status = await client.getStatus();
    expect(methods).toContain('call_tool');
    expect(methods).toContain('ping');
    expect(status.servers[0]?.cachedCapabilities).toBeNull();
  });

  it('rejects malformed or mismatched responses', async () => {
    const malformedPort = await startServer(() => ({ raw: 'not-json\n' }));
    await expect(
      new BackendControlClient({ port: malformedPort, requestTimeoutMs: 1_000 }).ping()
    ).rejects.toBeInstanceOf(BackendRpcError);

    const mismatchedPort = await startServer(() => ({ raw: '{"id":"wrong","result":{}}\n' }));
    await expect(
      new BackendControlClient({ port: mismatchedPort, requestTimeoutMs: 1_000 }).ping()
    ).rejects.toThrow(/mismatched response id/);
  });
});
