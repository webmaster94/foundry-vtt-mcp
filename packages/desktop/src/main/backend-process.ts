import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SpawnedBackend } from './backend-supervisor.js';
import { BackendIdentity } from '../shared/contracts.js';

export interface BackendProcessPaths {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  configPath: string;
}

export function resolveBackendBundle(paths: BackendProcessPaths): string {
  return paths.isPackaged
    ? path.join(paths.resourcesPath, 'server', 'backend.bundle.cjs')
    : path.resolve(paths.appPath, '..', 'mcp-server', 'dist', 'backend.js');
}

export function sameResolvedPath(left: string, right: string): boolean {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

export function backendIdentityMatches(
  identity: BackendIdentity,
  expectedEntryPath: string
): boolean {
  if (!identity.entryPath || !sameResolvedPath(identity.entryPath, expectedEntryPath)) return false;
  try {
    const stat = fs.statSync(expectedEntryPath);
    const expectedSignature = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    return identity.entrySig === expectedSignature;
  } catch {
    return false;
  }
}

export function resolveNodeExecutable(paths: BackendProcessPaths): {
  command: string;
  runAsNode: boolean;
} {
  const configured = process.env.FOUNDRY_MCP_NODE_EXECUTABLE;
  if (configured) return { command: configured, runAsNode: false };

  if (paths.isPackaged && process.platform === 'win32') {
    const bundledNode = path.resolve(paths.resourcesPath, '..', 'runtime', 'node.exe');
    if (fs.existsSync(bundledNode)) return { command: bundledNode, runAsNode: false };
  }

  if (process.versions.electron) return { command: process.execPath, runAsNode: true };
  return { command: process.execPath || 'node', runAsNode: false };
}

export async function spawnBackendProcess(paths: BackendProcessPaths): Promise<SpawnedBackend> {
  const backendBundle = resolveBackendBundle(paths);
  if (!fs.existsSync(backendBundle)) {
    const command = paths.isPackaged ? 'npm run bundle:server' : 'npm run build:server';
    throw new Error(`Backend entry is missing: ${backendBundle}. Run ${command} first.`);
  }
  const runtime = resolveNodeExecutable(paths);
  const environment = {
    ...process.env,
    FOUNDRY_SERVERS_CONFIG: paths.configPath,
    ...(runtime.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  if (!runtime.runAsNode) delete environment.ELECTRON_RUN_AS_NODE;

  return new Promise<SpawnedBackend>((resolve, reject) => {
    const child = spawn(runtime.command, [backendBundle], {
      cwd: path.dirname(paths.configPath),
      env: environment,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let launched = false;
    child.on('error', error => {
      if (!launched) {
        reject(
          new Error(`Could not launch the backend runtime (${runtime.command}): ${error.message}`, {
            cause: error,
          })
        );
      }
      // After the spawn event this listener still prevents a later child
      // process error from becoming an unhandled Electron main-process event.
    });
    child.once('spawn', () => {
      launched = true;
      child.unref();
      resolve({
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        kill: () => child.kill(),
      });
    });
  });
}
