import { describe, expect, it, vi } from 'vitest';
import { ConnectionRecoveryController } from '../src/connection-recovery.js';

describe('ConnectionRecoveryController', () => {
  it('wakes on online, pageshow, and visible resume without leaking listeners', async () => {
    const browserWindow = new EventTarget();
    const browserDocument = new EventTarget() as EventTarget & { visibilityState: string };
    browserDocument.visibilityState = 'hidden';
    const recover = vi.fn();
    const controller = new ConnectionRecoveryController(
      recover,
      browserWindow as unknown as Window,
      browserDocument as unknown as Document
    );

    controller.start();
    controller.start();
    browserWindow.dispatchEvent(new Event('online'));
    browserWindow.dispatchEvent(new Event('pageshow'));
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    browserDocument.visibilityState = 'visible';
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(recover).toHaveBeenCalledTimes(3);

    controller.stop();
    controller.stop();
    browserWindow.dispatchEvent(new Event('online'));
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    expect(recover).toHaveBeenCalledTimes(3);
  });
});
