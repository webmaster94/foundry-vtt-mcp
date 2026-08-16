import type { DesktopBridgeApi } from '../shared/contracts.js';

declare global {
  interface Window {
    foundryMcpDesktop: DesktopBridgeApi;
  }
}

export {};
