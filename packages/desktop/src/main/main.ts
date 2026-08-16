import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { BackendControlClient } from './control-client.js';
import { BackendSupervisor } from './backend-supervisor.js';
import {
  backendIdentityMatches,
  resolveBackendBundle,
  sameResolvedPath,
  spawnBackendProcess,
} from './backend-process.js';
import { ConfigStore } from './config-store.js';
import { createDefaultServersConfig, validateServersConfig } from './config-validation.js';
import { maskServersConfig } from './editable-config.js';
import { saveAndApplyConnections } from './connection-config-service.js';
import { createApplicationMenuTemplate } from './application-menu.js';
import {
  assertTrustedExternalUrl,
  assertTrustedIpcSender,
  hardenWebContents,
  SECURE_WEB_PREFERENCES,
} from './security.js';
import { initializeConfigSafely } from './startup-config.js';
import { parseLaunchIntent } from './launch-intent.js';
import { TrayController } from './tray-controller.js';
import { createMultiRepresentationTrayIcon } from './tray-icons.js';
import { enforceSingleInstance, ManagedWindow, WindowManager } from './window-manager.js';
import {
  DesktopStatus,
  EditableConfigSnapshot,
  IPC_CHANNELS,
  NavigationTarget,
  SaveConnectionsRequest,
  ServersConfig,
  TRUSTED_EXTERNAL_URLS,
} from '../shared/contracts.js';

const APPLICATION_NAME = 'FoundryVTT MCP Bridge';
const APPLICATION_DISPLAY_NAME = 'Foundry VTT MCP Bridge';
const launchIntent = parseLaunchIntent(process.argv);
const isE2e = process.env.FOUNDRY_MCP_DESKTOP_E2E === '1';

app.setName(APPLICATION_NAME);
const e2eUserData = process.env.FOUNDRY_MCP_DESKTOP_E2E_USER_DATA;
const canonicalUserData =
  isE2e && e2eUserData
    ? path.resolve(e2eUserData)
    : path.join(app.getPath('appData'), APPLICATION_NAME);
app.setPath('userData', canonicalUserData);

const configuredConfigPath = process.env.FOUNDRY_SERVERS_CONFIG;
const configPath = configuredConfigPath
  ? path.resolve(configuredConfigPath)
  : path.join(canonicalUserData, 'foundry-servers.json');
process.env.FOUNDRY_SERVERS_CONFIG = configPath;

const parsedControlPort = Number.parseInt(process.env.FOUNDRY_MCP_CONTROL_PORT ?? '31414', 10);
const controlPort = Number.isInteger(parsedControlPort) ? parsedControlPort : 31414;
const control = new BackendControlClient({ port: controlPort, configPath });
const configStore = new ConfigStore<ServersConfig>(
  configPath,
  validateServersConfig,
  createDefaultServersConfig
);
const backendPaths = {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  configPath,
};
const expectedBackendBundle = resolveBackendBundle(backendPaths);
const matchesManagedBackend = (status: import('../shared/contracts.js').BackendStatusResult) =>
  backendIdentityMatches(status.backend, expectedBackendBundle) &&
  status.config.path !== null &&
  sameResolvedPath(status.config.path, configPath);
const supervisor = new BackendSupervisor({
  control,
  spawnBackend: isE2e
    ? async () => {
        throw new Error('Backend startup is disabled by the desktop E2E harness');
      }
    : () => spawnBackendProcess(backendPaths),
  acceptBackendIdentity: identity => backendIdentityMatches(identity, expectedBackendBundle),
  acceptBackendStatus: matchesManagedBackend,
  ...(isE2e ? { startupTimeoutMs: 250, monitorIntervalMs: 250 } : {}),
});
const windowManager = new WindowManager();

let mainWindow: BrowserWindow | null = null;
let trayController: TrayController | null = null;
let exitPromise: Promise<void> | null = null;
let rendererReady = false;
let pendingNavigation: NavigationTarget | null = null;

function assetPath(...parts: string[]): string {
  return path.join(__dirname, 'assets', ...parts);
}

function sendNavigation(target: NavigationTarget): void {
  windowManager.show();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!rendererReady) {
    pendingNavigation = target;
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.navigate, target);
}

function createMainWindow(): BrowserWindow {
  const indexPath = path.join(__dirname, 'index.html');
  const window = new BrowserWindow({
    title: APPLICATION_NAME,
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#111820',
    icon: assetPath(process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      ...SECURE_WEB_PREFERENCES,
    },
  });
  hardenWebContents(window.webContents, pathToFileURL(indexPath).toString());
  window.webContents.once('did-finish-load', () => {
    rendererReady = true;
    if (pendingNavigation) {
      window.webContents.send(IPC_CHANNELS.navigate, pendingNavigation);
      pendingNavigation = null;
    }
  });
  window.on('closed', () => {
    rendererReady = false;
    mainWindow = null;
  });
  windowManager.attach(window as unknown as ManagedWindow);
  void window.loadFile(indexPath);
  mainWindow = window;
  return window;
}

async function showAbout(): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: `About ${APPLICATION_DISPLAY_NAME}`,
    message: APPLICATION_DISPLAY_NAME,
    detail: `Version ${app.getVersion()}\n\n${TRUSTED_EXTERNAL_URLS.documentation}\n\nThird-party notices are included with the application.`,
    buttons: ['Project website', 'OK'],
    defaultId: 1,
    cancelId: 1,
    icon: assetPath(process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'),
    noLink: true,
  });
  if (result.response === 0) openTrustedUrl(TRUSTED_EXTERNAL_URLS.documentation);
}

function openTrustedUrl(url: string): void {
  void shell.openExternal(assertTrustedExternalUrl(url));
}

async function requestExit(): Promise<void> {
  if (exitPromise) return exitPromise;
  exitPromise = (async () => {
    windowManager.beginQuit();
    trayController?.destroy();
    trayController = null;
    await supervisor.shutdown();
    app.quit();
  })();
  return exitPromise;
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      createApplicationMenuTemplate({
        hide: () => windowManager.hide(),
        exit: () => void requestExit(),
        editConnections: () => sendNavigation('connections'),
        about: () => void showAbout(),
        openDocumentation: () => openTrustedUrl(TRUSTED_EXTERNAL_URLS.documentation),
        reportIssue: () => openTrustedUrl(TRUSTED_EXTERNAL_URLS.issues),
      })
    )
  );
}

function createTray(): void {
  const assetsDirectory = assetPath();
  const icons = {
    connected: createMultiRepresentationTrayIcon(assetsDirectory, 'connected', nativeImage),
    waiting: createMultiRepresentationTrayIcon(assetsDirectory, 'waiting', nativeImage),
    error: createMultiRepresentationTrayIcon(assetsDirectory, 'error', nativeImage),
  };
  const tray = new Tray(icons.waiting);
  trayController = new TrayController(tray, Menu, icons, {
    open: () => windowManager.show(),
    exit: () => void requestExit(),
  });
  trayController.update(supervisor.getStatus());
}

function isSaveConfigRequest(value: unknown): value is SaveConnectionsRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(request, 'value') &&
    (request.expectedHash === null || typeof request.expectedHash === 'string') &&
    typeof request.authTokenUpdates === 'object' &&
    request.authTokenUpdates !== null &&
    !Array.isArray(request.authTokenUpdates) &&
    typeof request.replaceInvalid === 'boolean'
  );
}

async function getEditableConfig(): Promise<EditableConfigSnapshot> {
  const inspection = await configStore.inspect();
  if (inspection.valid) {
    return { ...inspection, value: maskServersConfig(inspection.value) };
  }
  return {
    ...inspection,
    value: maskServersConfig(validateServersConfig(createDefaultServersConfig())),
  };
}

function handleTrustedIpc(channel: string, listener: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) throw new Error('The main window is unavailable');
    assertTrustedIpcSender(event, window.webContents, window.webContents.mainFrame);
    return listener(...args);
  });
}

function installIpcHandlers(): void {
  handleTrustedIpc(IPC_CHANNELS.getStatus, () => supervisor.refresh());
  handleTrustedIpc(IPC_CHANNELS.getConnectionsConfig, () => getEditableConfig());
  handleTrustedIpc(IPC_CHANNELS.saveConnectionsConfig, async (request: unknown) => {
    if (!isSaveConfigRequest(request)) throw new Error('Invalid save-connections request');
    return saveAndApplyConnections(request, {
      configStore,
      control,
      supervisor,
      matchesManagedBackend,
    });
  });
  handleTrustedIpc(IPC_CHANNELS.showConnections, () => sendNavigation('connections'));
  handleTrustedIpc(IPC_CHANNELS.openConfigFolder, () => shell.showItemInFolder(configPath));
  handleTrustedIpc(IPC_CHANNELS.getAppInfo, () => ({
    name: APPLICATION_NAME,
    version: app.getVersion(),
    platform: process.platform,
    configPath,
  }));
}

function publishStatus(status: DesktopStatus): void {
  trayController?.update(status);
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(IPC_CHANNELS.statusChanged, status);
  }
}

const primaryInstance = enforceSingleInstance(
  app as unknown as import('./window-manager.js').SingleInstanceApplication,
  data => {
    if (data.shutdownForUpdate === true) {
      void requestExit();
    } else if (data.show !== false) {
      windowManager.show();
    }
  },
  { ...launchIntent }
);

if (primaryInstance) {
  app.on('before-quit', () => windowManager.beginQuit());
  app.on('window-all-closed', () => {
    // Deliberately stay alive in the notification area.
  });
  app.on('activate', () => windowManager.show());

  void app.whenReady().then(async () => {
    if (launchIntent.shutdownForUpdate) {
      await requestExit();
      return;
    }
    if (process.platform === 'win32')
      app.setAppUserModelId('io.github.webmaster94.foundry-vtt-mcp');
    await initializeConfigSafely(configStore);
    installIpcHandlers();
    const window = createMainWindow();
    installApplicationMenu();
    createTray();
    supervisor.subscribe(publishStatus);
    if (launchIntent.show) {
      window.once('ready-to-show', () => windowManager.show());
    }
    await supervisor.ensureRunning();
  });
}
