import type { WebContents } from 'electron';
import { TRUSTED_EXTERNAL_URLS } from '../shared/contracts.js';

export const SECURE_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
});

export interface SecureWebContents {
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void
  ): unknown;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  session: {
    setPermissionRequestHandler(
      handler: (
        _webContents: WebContents,
        permission: string,
        callback: (allowed: boolean) => void
      ) => void
    ): void;
  };
}

export interface TrustedIpcEvent {
  sender: unknown;
  senderFrame: unknown;
}

export function assertTrustedIpcSender(
  event: TrustedIpcEvent,
  expectedSender: unknown,
  expectedMainFrame: unknown
): void {
  if (event.sender !== expectedSender || event.senderFrame !== expectedMainFrame) {
    throw new Error('Rejected IPC request from an untrusted renderer frame');
  }
}

export function hardenWebContents(contents: SecureWebContents, allowedDocumentUrl: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, targetUrl) => {
    try {
      const allowed = new URL(allowedDocumentUrl);
      const target = new URL(targetUrl);
      if (target.href !== allowed.href) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  );
}

export function assertTrustedExternalUrl(url: string): string {
  const trusted = Object.values(TRUSTED_EXTERNAL_URLS) as string[];
  if (!trusted.includes(url)) throw new Error(`Refusing to open untrusted external URL: ${url}`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error(`Refusing to open untrusted external URL: ${url}`);
  }
  return parsed.toString();
}
