import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backendIdentityMatches,
  resolveBackendBundle,
  sameResolvedPath,
} from '../src/main/backend-process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('backend process ownership', () => {
  it('resolves the packaged server payload under resources/server', () => {
    expect(
      resolveBackendBundle({
        isPackaged: true,
        resourcesPath: path.join('C:', 'Bridge', 'resources'),
        appPath: path.join('C:', 'Bridge', 'resources', 'app.asar'),
        configPath: path.join('C:', 'Config', 'foundry-servers.json'),
      })
    ).toBe(path.join('C:', 'Bridge', 'resources', 'server', 'backend.bundle.cjs'));
  });

  it('uses the same compiled backend.js entry as source stdio wrappers in development', () => {
    const appPath = path.join('C:', 'repo', 'packages', 'desktop');
    expect(
      resolveBackendBundle({
        isPackaged: false,
        resourcesPath: path.join('C:', 'electron', 'resources'),
        appPath,
        configPath: path.join('C:', 'config', 'foundry-servers.json'),
      })
    ).toBe(path.resolve(appPath, '..', 'mcp-server', 'dist', 'backend.js'));
  });

  it('accepts only the exact live bundle path and on-disk signature', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-mcp-backend-identity-'));
    roots.push(root);
    const bundle = path.join(root, 'backend.bundle.cjs');
    await fs.writeFile(bundle, 'backend payload', 'utf8');
    const stat = await fs.stat(bundle);
    const identity = {
      ok: true as const,
      pid: 10,
      startedAt: 'now',
      entryPath: bundle,
      entrySig: `${stat.size}:${Math.round(stat.mtimeMs)}`,
    };

    expect(sameResolvedPath(bundle, path.resolve(bundle))).toBe(true);
    expect(backendIdentityMatches(identity, bundle)).toBe(true);
    expect(backendIdentityMatches({ ...identity, entrySig: 'stale' }, bundle)).toBe(false);
    expect(backendIdentityMatches({ ...identity, entryPath: `${bundle}.other` }, bundle)).toBe(
      false
    );
  });
});
