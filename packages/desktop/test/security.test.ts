import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  assertTrustedExternalUrl,
  assertTrustedIpcSender,
  hardenWebContents,
  SECURE_WEB_PREFERENCES,
  SecureWebContents,
} from '../src/main/security.js';
import { IPC_CHANNELS, TRUSTED_EXTERNAL_URLS } from '../src/shared/contracts.js';

describe('renderer security boundary', () => {
  it('keeps Node isolated and the renderer sandboxed', () => {
    expect(SECURE_WEB_PREFERENCES).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true);
    expect(new Set(Object.values(IPC_CHANNELS)).size).toBe(Object.keys(IPC_CHANNELS).length);
  });

  it('denies popups, webviews, permissions, and navigation away from the app document', () => {
    let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    let attachWebview: ((event: { preventDefault(): void }) => void) | undefined;
    let windowHandler: (() => { action: 'deny' }) | undefined;
    let permissionHandler:
      | ((_contents: WebContents, permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    const contents = {
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'will-navigate') {
          navigate = listener as typeof navigate;
        } else if (event === 'will-attach-webview') {
          attachWebview = listener as typeof attachWebview;
        }
      }),
      setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
        windowHandler = handler;
      }),
      session: {
        setPermissionRequestHandler: vi.fn((handler: typeof permissionHandler) => {
          permissionHandler = handler;
        }),
      },
    };
    const documentUrl = 'file:///C:/Program%20Files/Bridge/resources/app.asar/dist/index.html';

    hardenWebContents(contents as SecureWebContents, documentUrl);
    expect(windowHandler?.()).toEqual({ action: 'deny' });

    const attachEvent = { preventDefault: vi.fn() };
    attachWebview?.(attachEvent);
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();

    const allowedEvent = { preventDefault: vi.fn() };
    navigate?.(allowedEvent, documentUrl);
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();

    for (const target of ['https://evil.example/index.html', 'not a url']) {
      const blockedEvent = { preventDefault: vi.fn() };
      navigate?.(blockedEvent, target);
      expect(blockedEvent.preventDefault).toHaveBeenCalledOnce();
    }

    const permissionCallback = vi.fn();
    permissionHandler?.({} as WebContents, 'notifications', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
  });

  it('only permits the hard-coded HTTPS GitHub destinations', () => {
    expect(assertTrustedExternalUrl(TRUSTED_EXTERNAL_URLS.documentation)).toBe(
      TRUSTED_EXTERNAL_URLS.documentation
    );
    expect(() => assertTrustedExternalUrl('https://github.com/other/project')).toThrow(
      /untrusted external URL/
    );
    expect(() => assertTrustedExternalUrl('javascript:alert(1)')).toThrow(/untrusted external URL/);
  });

  it('accepts IPC only from the trusted main frame', () => {
    const sender = {};
    const mainFrame = {};
    expect(() =>
      assertTrustedIpcSender({ sender, senderFrame: mainFrame }, sender, mainFrame)
    ).not.toThrow();
    expect(() => assertTrustedIpcSender({ sender, senderFrame: {} }, sender, mainFrame)).toThrow(
      /untrusted renderer frame/
    );
    expect(() =>
      assertTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, sender, mainFrame)
    ).toThrow(/untrusted renderer frame/);
  });
});
