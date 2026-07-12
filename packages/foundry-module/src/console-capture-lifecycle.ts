/**
 * The small surface the activity lifecycle needs from browser console capture.
 * Keeping this structural avoids coupling the policy code to Foundry globals.
 */
export interface ConsoleCaptureController {
  start(): void;
  stop(): void;
  getStatus?(): { active: boolean };
}

export interface ConsoleCapturePolicy {
  /** Whether console capture is permitted at all. */
  enabled: boolean;
  /** Stop capture after MCP request activity has been idle for the configured delay. */
  suspendWhileIdle: boolean;
  /** Grace period after the final concurrent request completes. */
  idleTimeoutMs: number;
}

export type ConsoleCaptureMode = 'disabled' | 'continuous' | 'activity';

export interface ConsoleCaptureLifecycleStatus extends ConsoleCapturePolicy {
  mode: ConsoleCaptureMode;
  bridgeRunning: boolean;
  shutdown: boolean;
  activeRequests: number;
  captureActive: boolean;
  idleTimerScheduled: boolean;
  idleDeadlineAt: number | null;
  lastActivityAt: number | null;
}

export interface ConsoleCaptureActivityToken {
  generation: number;
}

/**
 * Derive the capture behavior from policy without consulting bridge state.
 * Bridge state is a separate hard gate applied by ConsoleCaptureLifecycle.
 */
export function deriveConsoleCaptureMode(policy: ConsoleCapturePolicy): ConsoleCaptureMode {
  if (!policy.enabled) return 'disabled';
  return policy.suspendWhileIdle ? 'activity' : 'continuous';
}

/**
 * Starts expensive browser console capture only while it is useful.
 *
 * Request classification deliberately lives outside this class. A caller can,
 * for example, handle transport pings without calling beginActivity(), while
 * wrapping real MCP queries in beginActivity()/endActivity().
 */
export class ConsoleCaptureLifecycle {
  private policy: ConsoleCapturePolicy;
  private bridgeRunning = false;
  private hasShutdown = false;
  private activeRequests = 0;
  private activityGeneration = 0;
  private managedCaptureActive = false;
  private idleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private idleDeadlineAt: number | null = null;
  private lastActivityAt: number | null = null;

  constructor(
    private readonly capture: ConsoleCaptureController,
    policy: ConsoleCapturePolicy
  ) {
    this.policy = this.normalizePolicy(policy);
    this.managedCaptureActive = this.readCaptureActive();
  }

  /** Open the bridge-running gate and apply the current policy. */
  start(): boolean {
    if (this.hasShutdown) return false;

    this.bridgeRunning = true;
    this.reconcileCapture();
    return true;
  }

  /**
   * Close the bridge-running gate. Outstanding request accounting is discarded
   * because a later bridge start represents a fresh connection lifecycle.
   */
  stop(): void {
    this.bridgeRunning = false;
    this.activityGeneration += 1;
    this.activeRequests = 0;
    this.clearIdleTimer();
    this.stopCapture();
  }

  /** Convenience for integrations that receive bridge state as a boolean. */
  setBridgeRunning(running: boolean): boolean {
    if (running) return this.start();
    this.stop();
    return !this.hasShutdown;
  }

  /** Permanently release timers and restore any patched console methods. */
  shutdown(): void {
    if (this.hasShutdown) return;

    this.hasShutdown = true;
    this.bridgeRunning = false;
    this.activityGeneration += 1;
    this.activeRequests = 0;
    this.clearIdleTimer();
    this.stopCapture();
  }

  /**
   * Mark a real MCP request as active. This synchronously starts capture before
   * returning for the first concurrent request.
   *
   * Returns false when the bridge gate is closed or the lifecycle is shut down;
   * callers may still safely call endActivity(), which will be a no-op.
   */
  beginActivity(): boolean {
    return this.beginTrackedActivity() !== null;
  }

  /** Begin activity and return a generation token for reconnect-safe completion. */
  beginTrackedActivity(): ConsoleCaptureActivityToken | null {
    if (!this.bridgeRunning || this.hasShutdown) return null;

    this.activeRequests += 1;
    this.lastActivityAt = Date.now();
    this.clearIdleTimer();

    if (deriveConsoleCaptureMode(this.policy) !== 'disabled') {
      this.startCapture();
    }

    return { generation: this.activityGeneration };
  }

  /**
   * Complete one request. The idle grace period begins only after the final
   * concurrent request has completed.
   */
  endActivity(): void {
    this.endTrackedActivity({ generation: this.activityGeneration });
  }

  /** Ignore completions from a transport generation that has already stopped. */
  endTrackedActivity(token: ConsoleCaptureActivityToken | null): void {
    if (!token || token.generation !== this.activityGeneration) return;
    if (this.activeRequests === 0) return;

    this.activeRequests -= 1;
    this.lastActivityAt = Date.now();

    if (this.activeRequests > 0) return;
    this.reconcileCapture();
  }

  /** Re-read settings in the integration layer and atomically apply the result. */
  refreshPolicy(policy: ConsoleCapturePolicy): void {
    this.policy = this.normalizePolicy(policy);
    this.clearIdleTimer();
    this.reconcileCapture();
  }

  getStatus(): ConsoleCaptureLifecycleStatus {
    return {
      ...this.policy,
      mode: deriveConsoleCaptureMode(this.policy),
      bridgeRunning: this.bridgeRunning,
      shutdown: this.hasShutdown,
      activeRequests: this.activeRequests,
      captureActive: this.readCaptureActive(),
      idleTimerScheduled: this.idleTimer !== null,
      idleDeadlineAt: this.idleDeadlineAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  private reconcileCapture(): void {
    this.clearIdleTimer();

    if (!this.bridgeRunning || this.hasShutdown) {
      this.stopCapture();
      return;
    }

    const mode = deriveConsoleCaptureMode(this.policy);
    if (mode === 'disabled') {
      this.stopCapture();
      return;
    }

    if (mode === 'continuous' || this.activeRequests > 0) {
      this.startCapture();
      return;
    }

    // Activity mode starts suspended. If capture is already active (for example
    // after a policy change from continuous mode), preserve the configured grace
    // period before restoring the original console methods.
    if (this.readCaptureActive()) {
      this.scheduleIdleStop();
    }
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();

    if (
      this.hasShutdown ||
      !this.bridgeRunning ||
      this.activeRequests > 0 ||
      deriveConsoleCaptureMode(this.policy) !== 'activity' ||
      !this.readCaptureActive()
    ) {
      return;
    }

    const delay = this.policy.idleTimeoutMs;
    this.idleDeadlineAt = Date.now() + delay;
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = null;
      this.idleDeadlineAt = null;

      if (
        !this.hasShutdown &&
        this.bridgeRunning &&
        this.activeRequests === 0 &&
        deriveConsoleCaptureMode(this.policy) === 'activity'
      ) {
        this.stopCapture();
      }
    }, delay);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      globalThis.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleDeadlineAt = null;
  }

  private startCapture(): void {
    if (this.readCaptureActive()) return;
    this.capture.start();
    this.managedCaptureActive = true;
    // Prefer the capture's authoritative state when it exposes one. Its start()
    // may intentionally no-op (for example, on a non-GM client).
    this.managedCaptureActive = this.readCaptureActive();
  }

  private stopCapture(): void {
    if (!this.readCaptureActive()) return;
    this.capture.stop();
    this.managedCaptureActive = false;
    this.managedCaptureActive = this.readCaptureActive();
  }

  private readCaptureActive(): boolean {
    try {
      const status = this.capture.getStatus?.();
      if (typeof status?.active === 'boolean') {
        this.managedCaptureActive = status.active;
      }
    } catch {
      // A lifecycle decision must remain possible while Foundry is still
      // bootstrapping and capture status cannot yet consult game settings.
    }
    return this.managedCaptureActive;
  }

  private normalizePolicy(policy: ConsoleCapturePolicy): ConsoleCapturePolicy {
    if (!Number.isFinite(policy.idleTimeoutMs) || policy.idleTimeoutMs < 0) {
      throw new RangeError('Console capture idleTimeoutMs must be a finite, non-negative number');
    }

    return {
      enabled: policy.enabled === true,
      suspendWhileIdle: policy.suspendWhileIdle === true,
      idleTimeoutMs: Math.floor(policy.idleTimeoutMs),
    };
  }
}
