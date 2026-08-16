import { contextBridge, ipcRenderer } from 'electron';
import {
  DesktopBridgeApi,
  DesktopStatus,
  IPC_CHANNELS,
  NavigationTarget,
  SaveConnectionsRequest,
} from './shared/contracts.js';

const api: DesktopBridgeApi = {
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getStatus),
  getConnectionsConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getConnectionsConfig),
  saveConnectionsConfig: (request: SaveConnectionsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveConnectionsConfig, request),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  showConnections: () => ipcRenderer.invoke(IPC_CHANNELS.showConnections),
  openConfigFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openConfigFolder),
  onStatusChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => listener(status);
    ipcRenderer.on(IPC_CHANNELS.statusChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.statusChanged, handler);
  },
  onNavigate: listener => {
    const handler = (_event: Electron.IpcRendererEvent, target: NavigationTarget) =>
      listener(target);
    ipcRenderer.on(IPC_CHANNELS.navigate, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.navigate, handler);
  },
};

contextBridge.exposeInMainWorld('foundryMcpDesktop', Object.freeze(api));
