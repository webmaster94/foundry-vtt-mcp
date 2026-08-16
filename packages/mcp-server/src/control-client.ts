import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import {
  CONTROL_HOST,
  CONTROL_PORT,
  type BackendPingResult,
  type BackendControlMethod,
  type BackendControlParams,
  type BackendControlResponse,
  type BackendControlResult,
} from './control-protocol.js';

export interface BackendControlClientOptions {
  host?: string;
  port?: number;
  backendPath?: string;
  nodeExecutable?: string;
  spawnBackend?: boolean;
  restartStaleBackend?: boolean;
  staleShutdownTimeoutMs?: number;
  stalePollIntervalMs?: number;
  logFile?: string;
}

export interface ControlSendOptions {
  /** Zero/undefined leaves long-running MCP tool calls unbounded, preserving legacy behavior. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

/**
 * Reusable client for the singleton backend's loopback JSON-lines channel.
 * The stdio wrapper and desktop main process intentionally share this code so
 * daemon startup/freshness behavior cannot drift between them.
 */
export class BackendControlClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private freshnessChecked = false;
  private ensurePromise: Promise<void> | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly backendPathOverride: string | undefined;
  private readonly nodeExecutable: string;
  private readonly shouldSpawnBackend: boolean;
  private readonly restartStaleBackend: boolean;
  private readonly staleShutdownTimeoutMs: number;
  private readonly stalePollIntervalMs: number;
  private readonly logFile: string;

  constructor(options: BackendControlClientOptions = {}) {
    this.host = options.host ?? CONTROL_HOST;
    this.port = options.port ?? CONTROL_PORT;
    this.backendPathOverride = options.backendPath;
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.shouldSpawnBackend = options.spawnBackend ?? true;
    this.restartStaleBackend = options.restartStaleBackend ?? true;
    this.staleShutdownTimeoutMs = options.staleShutdownTimeoutMs ?? 15_000;
    this.stalePollIntervalMs = options.stalePollIntervalMs ?? 100;
    this.logFile = options.logFile ?? path.join(os.tmpdir(), 'foundry-mcp-server', 'wrapper.log');
  }

  log(message: string, meta?: unknown): void {
    try {
      const directory = path.dirname(this.logFile);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      fs.appendFileSync(this.logFile, `[${new Date().toISOString()}] ${message}${suffix}\n`);
    } catch {
      // Logging must never break the MCP transport.
    }
  }

  async ensure(): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;
    if (
      this.socket &&
      !this.socket.destroyed &&
      (this.freshnessChecked || !this.restartStaleBackend)
    ) {
      return;
    }

    const operation = this.ensureInternal();
    this.ensurePromise = operation;
    try {
      await operation;
    } finally {
      if (this.ensurePromise === operation) this.ensurePromise = null;
    }
  }

  private async ensureInternal(): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      this.log('ensure(): connecting to backend');
      await this.connectWithRetry();
    }

    if (this.freshnessChecked || !this.restartStaleBackend) return;
    this.freshnessChecked = true;
    let pong: BackendPingResult;
    try {
      pong = await this.sendConnected('ping', {}, { timeoutMs: 5_000 });
    } catch (error) {
      this.log('ensure(): freshness check failed (continuing)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const currentSig = this.computeEntrySig();
    if (pong.entrySig && currentSig && pong.entrySig !== currentSig) {
      this.log('ensure(): backend is stale, restarting it', {
        running: pong.entrySig,
        onDisk: currentSig,
        instanceId: pong.instanceId,
      });
      this.freshnessChecked = false;
      await this.replaceStaleBackend(pong, currentSig);
      this.freshnessChecked = true;
    }
  }

  private async replaceStaleBackend(stale: BackendPingResult, currentSig: string): Promise<void> {
    await this.sendConnected('shutdown', {}, { timeoutMs: 5_000 }).catch(error => {
      this.log('replaceStaleBackend(): shutdown request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.dropSocket(new Error('Replacing stale backend'));

    const deadline = Date.now() + this.staleShutdownTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.stalePollIntervalMs));
      try {
        await this.connect();
      } catch {
        // The old listener is gone. Start (or race another wrapper to) the
        // replacement through the normal singleton startup path.
        await this.connectWithRetry();
        const replacement = await this.sendConnected('ping', {}, { timeoutMs: 5_000 });
        this.assertFreshReplacement(stale, replacement, currentSig);
        return;
      }

      let candidate: BackendPingResult | null = null;
      try {
        candidate = await this.sendConnected('ping', {}, { timeoutMs: 2_000 });
      } catch {
        // A listener closing during ping is equivalent to it being gone.
      }
      if (candidate && !this.isSameBackendInstance(stale, candidate)) {
        this.assertFreshReplacement(stale, candidate, currentSig);
        return;
      }
      this.dropSocket(new Error('Waiting for stale backend to exit'));
    }

    throw new Error(
      `Stale Foundry MCP backend PID ${stale.pid} did not exit within ${this.staleShutdownTimeoutMs}ms`
    );
  }

  private assertFreshReplacement(
    stale: BackendPingResult,
    replacement: BackendPingResult,
    currentSig: string
  ): void {
    if (this.isSameBackendInstance(stale, replacement)) {
      throw new Error(`Reconnected to stale Foundry MCP backend PID ${stale.pid}`);
    }
    if (currentSig && replacement.entrySig !== currentSig) {
      throw new Error(
        `Replacement backend build mismatch (running ${replacement.entrySig || 'unknown'}, expected ${currentSig})`
      );
    }
  }

  private isSameBackendInstance(first: BackendPingResult, second: BackendPingResult): boolean {
    if (first.instanceId && second.instanceId) return first.instanceId === second.instanceId;
    return first.pid === second.pid && first.entrySig === second.entrySig;
  }

  private dropSocket(error: Error): void {
    const socket = this.socket;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectAll(error, socket ?? undefined);
    if (!socket) {
      this.buffer = '';
      this.socket = null;
    }
  }

  resolveBackendPath(): string {
    if (this.backendPathOverride) return path.resolve(this.backendPathOverride);
    try {
      return fileURLToPath(new URL('./backend.js', import.meta.url));
    } catch {
      const baseDirectory =
        typeof __dirname !== 'undefined'
          ? __dirname
          : path.dirname(process.argv[1] || process.cwd());
      const bundleCandidate = path.join(baseDirectory, 'backend.bundle.cjs');
      return fs.existsSync(bundleCandidate)
        ? bundleCandidate
        : path.join(baseDirectory, 'backend.js');
    }
  }

  computeEntrySig(): string {
    try {
      const stat = fs.statSync(this.resolveBackendPath());
      return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return '';
    }
  }

  async send<M extends BackendControlMethod>(
    method: M,
    params: BackendControlParams<M>,
    options: ControlSendOptions = {}
  ): Promise<BackendControlResult<M>> {
    await this.ensure();
    return this.sendConnected(method, params, options);
  }

  private sendConnected<M extends BackendControlMethod>(
    method: M,
    params: BackendControlParams<M>,
    options: ControlSendOptions
  ): Promise<BackendControlResult<M>> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected to Foundry MCP backend'));
        return;
      }

      const id = randomUUID();
      const timeoutMs = options.timeoutMs ?? 0;
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              const pending = this.pending.get(id);
              if (!pending) return;
              this.pending.delete(id);
              reject(new Error(`Timeout waiting for ${method}`));
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        resolve: value => resolve(value as BackendControlResult<M>),
        reject,
        timeout,
      });

      try {
        this.log('send(): write', { method });
        this.socket.write(JSON.stringify({ id, method, params }) + '\n', 'utf8');
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  cleanup(): void {
    this.log('cleanup(): closing control socket (backend stays running)');
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.rejectAll(new Error('Control client closed'));
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;

      const rejectInitial = (error: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.once('error', rejectInitial);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        socket.off('error', rejectInitial);
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
        socket.on('error', error => this.rejectAll(error, socket));
        socket.on('close', () => this.rejectAll(new Error('Backend disconnected'), socket));
        this.log('connect(): connected to backend');
        resolve();
      });
    });
  }

  private async connectWithRetry(): Promise<void> {
    try {
      await this.connect();
      return;
    } catch (initialError) {
      if (!this.shouldSpawnBackend) throw initialError;
      this.log('connectWithRetry(): starting backend');
      this.startBackend();

      const maxAttempts = 40;
      let lastError: unknown = initialError;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const delayMs = Math.min(250 * Math.pow(1.4, attempt), 2_000);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
          await this.connect();
          return;
        } catch (error) {
          lastError = error;
          this.log('connectWithRetry(): retry failed', {
            attempt: attempt + 1,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const message = lastError instanceof Error ? lastError.message : 'Unknown error';
      throw new Error(
        `Unable to connect to Foundry MCP backend after ${maxAttempts} attempts: ${message}`
      );
    }
  }

  private startBackend(): void {
    const backendPath = this.resolveBackendPath();
    this.log('startBackend(): spawning persistent backend', { path: backendPath });

    if (process.platform === 'win32') {
      const child = spawn(
        'cmd.exe',
        ['/d', '/s', '/c', `start "" /b "${this.nodeExecutable}" "${backendPath}"`],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true,
        }
      );
      child.unref();
      return;
    }

    const child = spawn(this.nodeExecutable, [backendPath], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      try {
        const message = JSON.parse(line) as BackendControlResponse;
        if (!message.id) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch (error) {
        this.log('onData(): JSON parse error', {
          error: error instanceof Error ? error.message : String(error),
          lineLength: line.length,
        });
      }
    }
  }

  private rejectAll(error: Error, sourceSocket?: net.Socket): void {
    if (sourceSocket && this.socket !== sourceSocket) return;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = '';
    this.socket = null;
  }
}
