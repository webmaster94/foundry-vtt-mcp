import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  pid = 4321;
  unref = vi.fn();
  kill = vi.fn(() => true);
}

const roots: string[] = [];

beforeEach(() => spawnMock.mockReset());
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function processPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-mcp-spawn-'));
  roots.push(root);
  const appPath = path.join(root, 'desktop');
  const backend = path.resolve(appPath, '..', 'mcp-server', 'dist', 'backend.js');
  const configPath = path.join(root, 'config', 'foundry-servers.json');
  await fs.mkdir(path.dirname(backend), { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(backend, 'backend', 'utf8');
  return {
    isPackaged: false,
    resourcesPath: path.join(root, 'resources'),
    appPath,
    configPath,
  };
}

describe('backend process spawning', () => {
  it('waits for the spawn event before detaching and returning ownership', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { spawnBackendProcess } = await import('../src/main/backend-process.js');
    const pending = spawnBackendProcess(await processPaths());

    expect(child.unref).not.toHaveBeenCalled();
    child.emit('spawn');
    const spawned = await pending;
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawned.pid).toBe(4321);
    expect(spawned.kill?.()).toBe(true);
  });

  it('rejects an asynchronous launch error instead of crashing Electron main', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { spawnBackendProcess } = await import('../src/main/backend-process.js');
    const pending = spawnBackendProcess(await processPaths());
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(pending).rejects.toThrow(/Could not launch the backend runtime.*ENOENT/);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
