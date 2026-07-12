import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleCaptureLifecycle,
  deriveConsoleCaptureMode,
  type ConsoleCaptureController,
} from './console-capture-lifecycle.js';

class FakeCapture implements ConsoleCaptureController {
  active = false;
  starts = 0;
  stops = 0;
  events: string[] = [];

  start(): void {
    if (this.active) return;
    this.active = true;
    this.starts += 1;
    this.events.push('start');
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stops += 1;
    this.events.push('stop');
  }

  getStatus(): { active: boolean } {
    return { active: this.active };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveConsoleCaptureMode', () => {
  it('derives disabled, continuous, and activity modes from policy', () => {
    expect(
      deriveConsoleCaptureMode({ enabled: false, suspendWhileIdle: false, idleTimeoutMs: 1000 })
    ).toBe('disabled');
    expect(
      deriveConsoleCaptureMode({ enabled: true, suspendWhileIdle: false, idleTimeoutMs: 1000 })
    ).toBe('continuous');
    expect(
      deriveConsoleCaptureMode({ enabled: true, suspendWhileIdle: true, idleTimeoutMs: 1000 })
    ).toBe('activity');
  });
});

describe('ConsoleCaptureLifecycle', () => {
  it('starts before the first request and waits for all concurrent requests before idling', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: true,
      idleTimeoutMs: 30_000,
    });

    lifecycle.start();
    expect(capture.active).toBe(false);

    expect(lifecycle.beginActivity()).toBe(true);
    expect(capture.active).toBe(true);
    expect(capture.starts).toBe(1);
    expect(lifecycle.beginActivity()).toBe(true);
    expect(capture.starts).toBe(1);
    expect(lifecycle.getStatus().activeRequests).toBe(2);

    lifecycle.endActivity();
    expect(lifecycle.getStatus().activeRequests).toBe(1);
    expect(lifecycle.getStatus().idleTimerScheduled).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(capture.active).toBe(true);

    lifecycle.endActivity();
    const status = lifecycle.getStatus();
    expect(status.activeRequests).toBe(0);
    expect(status.idleTimerScheduled).toBe(true);
    expect(status.idleDeadlineAt).toBe(Date.now() + 30_000);

    vi.advanceTimersByTime(29_999);
    expect(capture.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(capture.active).toBe(false);
    expect(capture.stops).toBe(1);
  });

  it('cancels a pending idle stop when new activity begins and rearms it afterward', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: true,
      idleTimeoutMs: 100,
    });

    lifecycle.start();
    lifecycle.beginActivity();
    lifecycle.endActivity();
    vi.advanceTimersByTime(75);

    lifecycle.beginActivity();
    expect(lifecycle.getStatus().idleTimerScheduled).toBe(false);
    vi.advanceTimersByTime(100);
    expect(capture.active).toBe(true);

    lifecycle.endActivity();
    vi.advanceTimersByTime(99);
    expect(capture.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(capture.active).toBe(false);
  });

  it('uses bridge state as a hard gate and stop cancels pending work', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: true,
      idleTimeoutMs: 100,
    });

    expect(lifecycle.beginActivity()).toBe(false);
    expect(capture.starts).toBe(0);

    lifecycle.start();
    lifecycle.beginActivity();
    lifecycle.endActivity();
    expect(lifecycle.getStatus().idleTimerScheduled).toBe(true);

    lifecycle.stop();
    expect(capture.active).toBe(false);
    expect(lifecycle.getStatus()).toMatchObject({
      bridgeRunning: false,
      activeRequests: 0,
      idleTimerScheduled: false,
    });
    vi.advanceTimersByTime(1_000);
    expect(capture.stops).toBe(1);
  });

  it('refreshes policy immediately and restarts the idle grace period', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: false,
      idleTimeoutMs: 1_000,
    });

    lifecycle.start();
    expect(capture.active).toBe(true);
    expect(lifecycle.getStatus().mode).toBe('continuous');

    lifecycle.refreshPolicy({ enabled: true, suspendWhileIdle: true, idleTimeoutMs: 100 });
    expect(lifecycle.getStatus()).toMatchObject({
      mode: 'activity',
      idleTimerScheduled: true,
    });
    vi.advanceTimersByTime(75);

    lifecycle.refreshPolicy({ enabled: true, suspendWhileIdle: true, idleTimeoutMs: 10 });
    vi.advanceTimersByTime(9);
    expect(capture.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(capture.active).toBe(false);

    lifecycle.refreshPolicy({ enabled: false, suspendWhileIdle: true, idleTimeoutMs: 10 });
    expect(lifecycle.getStatus().mode).toBe('disabled');
    lifecycle.refreshPolicy({ enabled: true, suspendWhileIdle: false, idleTimeoutMs: 10 });
    expect(capture.active).toBe(true);
  });

  it('applies refreshed policy to an in-flight request', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: false,
      suspendWhileIdle: true,
      idleTimeoutMs: 25,
    });

    lifecycle.start();
    lifecycle.beginActivity();
    expect(capture.active).toBe(false);

    lifecycle.refreshPolicy({ enabled: true, suspendWhileIdle: true, idleTimeoutMs: 25 });
    expect(capture.active).toBe(true);
    expect(lifecycle.getStatus().activeRequests).toBe(1);

    lifecycle.endActivity();
    vi.advanceTimersByTime(25);
    expect(capture.active).toBe(false);
  });

  it('leaves ping classification outside the lifecycle', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: true,
      idleTimeoutMs: 10,
    });

    lifecycle.start();
    // A transport ping does not call beginActivity().
    vi.advanceTimersByTime(1_000);
    expect(capture.events).toEqual([]);
    expect(lifecycle.getStatus().lastActivityAt).toBeNull();
  });

  it('ignores a request completion from before a disconnect and reconnect', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: true,
      idleTimeoutMs: 100,
    });

    lifecycle.start();
    const staleToken = lifecycle.beginTrackedActivity();
    lifecycle.stop();
    lifecycle.start();
    const currentToken = lifecycle.beginTrackedActivity();

    lifecycle.endTrackedActivity(staleToken);
    expect(lifecycle.getStatus()).toMatchObject({
      activeRequests: 1,
      idleTimerScheduled: false,
    });

    lifecycle.endTrackedActivity(currentToken);
    expect(lifecycle.getStatus()).toMatchObject({
      activeRequests: 0,
      idleTimerScheduled: true,
    });
  });

  it('shutdown restores capture, cancels timers, and cannot be restarted', () => {
    vi.useFakeTimers();
    const capture = new FakeCapture();
    const lifecycle = new ConsoleCaptureLifecycle(capture, {
      enabled: true,
      suspendWhileIdle: true,
      idleTimeoutMs: 100,
    });

    lifecycle.start();
    lifecycle.beginActivity();
    lifecycle.endActivity();
    lifecycle.shutdown();

    expect(capture.active).toBe(false);
    expect(lifecycle.getStatus()).toMatchObject({
      shutdown: true,
      bridgeRunning: false,
      activeRequests: 0,
      idleTimerScheduled: false,
    });
    expect(lifecycle.start()).toBe(false);
    expect(lifecycle.beginActivity()).toBe(false);
    lifecycle.refreshPolicy({ enabled: true, suspendWhileIdle: false, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(1_000);
    expect(capture.starts).toBe(1);
    expect(capture.stops).toBe(1);
  });

  it('rejects invalid idle timeouts', () => {
    const capture = new FakeCapture();
    expect(
      () =>
        new ConsoleCaptureLifecycle(capture, {
          enabled: true,
          suspendWhileIdle: true,
          idleTimeoutMs: Number.NaN,
        })
    ).toThrow(RangeError);
  });
});
