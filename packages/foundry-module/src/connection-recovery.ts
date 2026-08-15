/**
 * Installs one set of browser lifecycle listeners that wakes the bridge's
 * existing reconnect owner after background throttling or network recovery.
 */
export class ConnectionRecoveryController {
  private installed = false;

  constructor(
    private readonly recover: () => void | Promise<void>,
    private readonly browserWindow: Window = window,
    private readonly browserDocument: Document = document
  ) {}

  start(): void {
    if (this.installed) return;
    this.installed = true;
    this.browserWindow.addEventListener('online', this.handleResume);
    this.browserWindow.addEventListener('pageshow', this.handleResume);
    this.browserDocument.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  stop(): void {
    if (!this.installed) return;
    this.installed = false;
    this.browserWindow.removeEventListener('online', this.handleResume);
    this.browserWindow.removeEventListener('pageshow', this.handleResume);
    this.browserDocument.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private readonly handleResume = (): void => {
    void Promise.resolve(this.recover()).catch(error => {
      console.warn('[foundry-mcp-bridge] Connection recovery failed:', error);
    });
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.browserDocument.visibilityState === 'visible') {
      this.handleResume();
    }
  };
}
