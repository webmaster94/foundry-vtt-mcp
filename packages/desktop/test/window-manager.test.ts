import { describe, expect, it, vi } from 'vitest';
import { enforceSingleInstance, ManagedWindow, WindowManager } from '../src/main/window-manager.js';

type Listener = (...args: unknown[]) => void;

class FakeWindow {
  destroyed = false;
  visible = true;
  minimized = false;
  show = vi.fn(() => {
    this.visible = true;
  });
  hide = vi.fn(() => {
    this.visible = false;
  });
  focus = vi.fn();
  restore = vi.fn(() => {
    this.minimized = false;
  });
  private readonly listeners = new Map<string, Listener[]>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe('WindowManager', () => {
  it('hides a close request and restores a minimized window on show', () => {
    const manager = new WindowManager();
    const window = new FakeWindow();
    manager.attach(window as unknown as ManagedWindow);
    const event = { preventDefault: vi.fn() };

    window.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();

    window.minimized = true;
    manager.show();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('allows the window to close after application shutdown begins', () => {
    const manager = new WindowManager();
    const window = new FakeWindow();
    manager.attach(window as unknown as ManagedWindow);
    manager.beginQuit();
    const event = { preventDefault: vi.fn() };

    window.emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(manager.isQuitting()).toBe(true);
  });
});

describe('single-instance enforcement', () => {
  it('quits a secondary instance', () => {
    const application = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn(),
    };

    expect(enforceSingleInstance(application, vi.fn(), { show: true })).toBe(false);
    expect(application.quit).toHaveBeenCalledOnce();
    expect(application.on).not.toHaveBeenCalled();
  });

  it('forwards the second instance launch data to the primary instance', () => {
    let listener: ((...args: unknown[]) => void) | undefined;
    const application = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((_event: string, callback: (...args: unknown[]) => void) => {
        listener = callback;
      }),
      quit: vi.fn(),
    };
    const onSecondInstance = vi.fn();

    expect(enforceSingleInstance(application, onSecondInstance, { show: false })).toBe(true);
    listener?.({}, [], '', { show: true });
    expect(onSecondInstance).toHaveBeenCalledWith({ show: true });
  });
});
