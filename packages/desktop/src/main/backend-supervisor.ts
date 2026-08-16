import { BackendPingResult, BackendStatusResult, DesktopStatus } from '../shared/contracts.js';

export interface BackendControl {
  ping(): Promise<BackendPingResult>;
  getStatus(): Promise<BackendStatusResult>;
  shutdown(): Promise<{ ok: boolean }>;
}

export interface SpawnedBackend {
  pid?: number;
  kill?(): boolean;
}

export interface BackendSupervisorOptions {
  control: BackendControl;
  spawnBackend: () => Promise<SpawnedBackend | void>;
  acceptBackendIdentity?: (identity: BackendPingResult) => boolean;
  acceptBackendStatus?: (status: BackendStatusResult) => boolean;
  startupTimeoutMs?: number;
  monitorIntervalMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export type StatusListener = (status: DesktopStatus) => void;

const wait = (milliseconds: number) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BackendSupervisor {
  private readonly control: BackendControl;
  private readonly spawnBackend: () => Promise<SpawnedBackend | void>;
  private readonly acceptBackendIdentity: (identity: BackendPingResult) => boolean;
  private readonly acceptBackendStatus: (status: BackendStatusResult) => boolean;
  private readonly startupTimeoutMs: number;
  private readonly monitorIntervalMs: number;
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly listeners = new Set<StatusListener>();
  private ensurePromise: Promise<DesktopStatus> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<DesktopStatus> | null = null;
  private shuttingDown = false;
  private managedInstanceId: string | null = null;
  private status: DesktopStatus;

  constructor(options: BackendSupervisorOptions) {
    this.control = options.control;
    this.spawnBackend = options.spawnBackend;
    this.acceptBackendIdentity = options.acceptBackendIdentity ?? (() => true);
    this.acceptBackendStatus = options.acceptBackendStatus ?? (() => true);
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.monitorIntervalMs = options.monitorIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? wait;
    this.status = {
      state: 'offline',
      checkedAt: this.now().toISOString(),
      status: null,
      message: 'Backend has not been contacted yet.',
    };
  }

  getStatus(): DesktopStatus {
    return this.status;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async ensureRunning(): Promise<DesktopStatus> {
    if (this.shuttingDown) return this.status;
    if (!this.shuttingDown) this.startMonitoring();
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureRunningInternal();
    try {
      return await this.ensurePromise;
    } finally {
      this.ensurePromise = null;
    }
  }

  async refresh(): Promise<DesktopStatus> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshInternal();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  startMonitoring(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      void this.refresh().then(status => {
        if (!this.shuttingDown && status.state === 'offline') void this.ensureRunning();
      });
    }, this.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  stopMonitoring(): void {
    if (!this.monitorTimer) return;
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopMonitoring();
    this.update({ state: 'stopping', status: this.status.status, message: 'Stopping backend…' });

    const targetInstanceId = this.managedInstanceId;
    if (!targetInstanceId) {
      this.update({
        state: 'offline',
        status: null,
        message: 'No desktop-managed backend instance is running.',
      });
      return;
    }

    try {
      const identity = await this.control.ping();
      const status = await this.control.getStatus();
      if (
        this.acceptedInstanceId(identity, status) !== targetInstanceId ||
        status.backend.instanceId !== targetInstanceId
      ) {
        this.update({
          state: 'offline',
          status: null,
          message:
            'The desktop-managed backend is no longer running; another instance was left untouched.',
        });
        return;
      }

      const result = await this.control.shutdown();
      if (!result.ok) {
        this.update({
          state: 'error',
          status: this.status.status,
          message: 'Backend rejected the shutdown request.',
        });
        return;
      }
    } catch {
      this.update({ state: 'offline', status: null, message: 'Backend stopped.' });
      return;
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await this.wait(100);
      try {
        const identity = await this.control.ping();
        if (identity.instanceId !== targetInstanceId) {
          this.update({ state: 'offline', status: null, message: 'Backend stopped.' });
          return;
        }
      } catch {
        this.update({ state: 'offline', status: null, message: 'Backend stopped.' });
        return;
      }
    }
    this.update({
      state: 'error',
      status: this.status.status,
      message: 'Backend did not stop in time.',
    });
  }

  private async ensureRunningInternal(): Promise<DesktopStatus> {
    let unexpectedBackend = false;
    try {
      const identity = await this.control.ping();
      const status = await this.control.getStatus();
      const acceptedInstanceId = this.acceptedInstanceId(identity, status);
      if (acceptedInstanceId) {
        this.managedInstanceId = acceptedInstanceId;
        return this.update({ state: 'online', status });
      }
      unexpectedBackend = true;
      this.update({
        state: 'starting',
        status: null,
        message: 'Replacing a bridge backend from another installation or configuration…',
      });
    } catch {
      this.update({ state: 'starting', status: null, message: 'Starting backend…' });
    }

    if (this.shuttingDown) {
      return this.update({ state: 'offline', status: null, message: 'Backend stopped.' });
    }

    if (unexpectedBackend && !(await this.stopUnexpectedBackend())) {
      return this.update({
        state: 'error',
        status: null,
        message: 'A different bridge backend is still using the control port. Close it and retry.',
      });
    }

    let spawned: SpawnedBackend | void;
    try {
      spawned = await this.spawnBackend();
    } catch (error) {
      const failed = this.update({
        state: 'error',
        status: null,
        message: `Could not start backend: ${errorMessage(error)}`,
      });
      return failed;
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    let delay = 75;
    while (Date.now() < deadline) {
      await this.wait(delay);
      if (this.shuttingDown) {
        spawned?.kill?.();
        return this.update({ state: 'offline', status: null, message: 'Backend stopped.' });
      }
      try {
        const identity = await this.control.ping();
        const status = await this.control.getStatus();
        const acceptedInstanceId = this.acceptedInstanceId(identity, status);
        if (!acceptedInstanceId) {
          spawned?.kill?.();
          return this.update({
            state: 'error',
            status: null,
            message: 'The started backend reported an unexpected executable or configuration path.',
          });
        }
        this.managedInstanceId = acceptedInstanceId;
        return this.update({ state: 'online', status });
      } catch {
        delay = Math.min(Math.round(delay * 1.5), 750);
      }
    }

    spawned?.kill?.();
    return this.update({
      state: 'error',
      status: null,
      message: `Backend did not become ready within ${this.startupTimeoutMs}ms.`,
    });
  }

  private async refreshInternal(): Promise<DesktopStatus> {
    try {
      const result = await this.control.getStatus();
      if (!this.acceptBackendStatus(result) || !result.backend.instanceId) {
        return this.update({
          state: 'offline',
          status: null,
          message: 'Backend is using a different server configuration file.',
        });
      }
      this.managedInstanceId = result.backend.instanceId;
      return this.update({ state: 'online', status: result });
    } catch (error) {
      return this.update({
        state: 'offline',
        status: null,
        message: `Backend unavailable: ${errorMessage(error)}`,
      });
    }
  }

  private async stopUnexpectedBackend(): Promise<boolean> {
    await this.control.shutdown().catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await this.wait(100);
      try {
        await this.control.ping();
      } catch {
        return true;
      }
    }
    return false;
  }

  private acceptedInstanceId(
    identity: BackendPingResult,
    status: BackendStatusResult
  ): string | null {
    if (!this.acceptBackendIdentity(identity) || !this.acceptBackendStatus(status)) return null;
    if (
      !identity.instanceId ||
      !status.backend.instanceId ||
      identity.instanceId !== status.backend.instanceId
    ) {
      return null;
    }
    return identity.instanceId;
  }

  private update(update: Omit<DesktopStatus, 'checkedAt'>): DesktopStatus {
    this.status = {
      ...update,
      checkedAt: this.now().toISOString(),
    };
    for (const listener of this.listeners) listener(this.status);
    return this.status;
  }
}
