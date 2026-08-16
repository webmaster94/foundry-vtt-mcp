export interface ClosableEvent {
  preventDefault(): void;
}

export interface ManagedWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  restore(): void;
  on(event: 'close', listener: (event: ClosableEvent) => void): unknown;
  on(event: 'closed', listener: () => void): unknown;
}

export class WindowManager {
  private window: ManagedWindow | null = null;
  private quitting = false;

  attach(window: ManagedWindow): void {
    this.window = window;
    window.on('close', event => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
  }

  show(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  hide(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.hide();
  }

  isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  beginQuit(): void {
    this.quitting = true;
  }

  isQuitting(): boolean {
    return this.quitting;
  }
}

export interface SingleInstanceApplication {
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  on(
    event: 'second-instance',
    listener: (
      event: unknown,
      argv: string[],
      workingDirectory: string,
      additionalData: Record<string, unknown>
    ) => void
  ): unknown;
  quit(): void;
}

export function enforceSingleInstance(
  application: SingleInstanceApplication,
  onSecondInstance: (additionalData: Record<string, unknown>) => void,
  additionalData: Record<string, unknown> = {}
): boolean {
  if (!application.requestSingleInstanceLock(additionalData)) {
    application.quit();
    return false;
  }
  application.on('second-instance', (_event, _argv, _workingDirectory, data) => {
    onSecondInstance(data ?? {});
  });
  return true;
}
