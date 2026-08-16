import {
  AuthTokenUpdate,
  BackendConnectionStatus,
  DesktopStatus,
  EditableServerProfile,
  EditableServersConfig,
  NavigationTarget,
} from '../shared/contracts.js';
import { redactedJsonPreview } from '../main/editable-config.js';
import { getListenerFailure } from '../shared/connection-health.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing renderer element #${id}`);
  return found as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const api = window.foundryMcpDesktop;
const overviewView = element<HTMLElement>('overview-view');
const connectionsView = element<HTMLElement>('connections-view');
const backendAlert = element<HTMLElement>('backend-alert');
const backendAlertMessage = element<HTMLElement>('backend-alert-message');
const connections = element<HTMLElement>('connections');
const refreshStatusButton = element<HTMLButtonElement>('refresh-status');
const profileList = element<HTMLElement>('profile-list');
const selectedProfileName = element<HTMLElement>('selected-profile-name');
const configPath = element<HTMLElement>('config-path');
const configPreview = element<HTMLElement>('config-preview');
const editorMessage = element<HTMLElement>('editor-message');
const saveButton = element<HTMLButtonElement>('save-config');
const invalidConfigAlert = element<HTMLElement>('invalid-config-alert');
const invalidConfigError = element<HTMLElement>('invalid-config-error');
const setDefaultButton = element<HTMLButtonElement>('set-default-profile');
const duplicateButton = element<HTMLButtonElement>('duplicate-profile');
const deleteButton = element<HTMLButtonElement>('delete-profile');
const tokenAction = element<HTMLSelectElement>('token-action');
const replacementTokenRow = element<HTMLElement>('replacement-token-row');
const replacementToken = element<HTMLInputElement>('replacement-token');
const tokenState = element<HTMLElement>('token-state');
const addProfileDialog = element<HTMLDialogElement>('add-profile-dialog');
const newProfileName = element<HTMLInputElement>('new-profile-name');
const newProfileError = element<HTMLElement>('new-profile-error');

let editorConfig: EditableServersConfig | null = null;
let selectedName: string | null = null;
let configHash: string | null = null;
let replacingInvalidConfig = false;
let tokenUpdates: Record<string, AuthTokenUpdate> = {};
let dirty = false;

function setView(target: NavigationTarget): void {
  const editing = target === 'connections';
  const enteringEditor = editing && connectionsView.classList.contains('hidden');
  overviewView.classList.toggle('hidden', editing);
  connectionsView.classList.toggle('hidden', !editing);
  if (enteringEditor) void loadConfig();
}

function livenessText(connectionInfo: unknown): string | null {
  if (!isRecord(connectionInfo) || !isRecord(connectionInfo.liveness)) return null;
  const liveness = connectionInfo.liveness;
  const timestamp =
    typeof liveness.connectedAt === 'number'
      ? liveness.connectedAt
      : typeof liveness.lastConnectedAt === 'number'
        ? liveness.lastConnectedAt
        : null;
  if (timestamp === null) return null;
  const label = typeof liveness.connectedAt === 'number' ? 'Connected' : 'Last connected';
  return `${label} ${new Date(timestamp).toLocaleString()}`;
}

function connectionCard(server: BackendConnectionStatus): HTMLElement {
  const listenerFailure = getListenerFailure(server);
  const card = document.createElement('article');
  card.className = `connection-card ${
    listenerFailure
      ? 'connection-card--error'
      : server.connected
        ? 'connection-card--connected'
        : ''
  }`;

  const heading = document.createElement('div');
  heading.className = 'connection-card__heading';
  const headingText = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = server.label || server.name;
  const endpoint = document.createElement('p');
  endpoint.textContent = `${server.host}:${server.port}`;
  headingText.append(title, endpoint);
  const badge = document.createElement('span');
  badge.className = `badge ${
    listenerFailure ? 'badge--error' : server.connected ? 'badge--connected' : 'badge--waiting'
  }`;
  badge.textContent = listenerFailure
    ? 'Listener error'
    : server.connected
      ? 'Connected'
      : 'Waiting';
  heading.append(headingText, badge);
  card.append(heading);

  const transport = document.createElement('p');
  transport.className = 'connection-card__meta';
  transport.textContent = `${server.connectionType} transport${server.remoteMode ? ' · remote listener' : ' · local listener'}`;
  card.append(transport);

  if (listenerFailure) {
    const error = document.createElement('p');
    error.className = 'connection-card__error';
    const occurred =
      listenerFailure.at === null ? '' : ` · ${new Date(listenerFailure.at).toLocaleString()}`;
    error.textContent = `${listenerFailure.message}${occurred}`;
    card.append(error);
  }

  const capabilities = server.cachedCapabilities;
  if (capabilities) {
    const world = document.createElement('p');
    world.className = 'connection-card__world';
    world.textContent = capabilities.world.title;
    const system = document.createElement('p');
    system.className = 'connection-card__meta';
    system.textContent = `${capabilities.system.id} ${capabilities.system.version} · Foundry ${capabilities.foundryVersion} · Module ${capabilities.moduleVersion}`;
    card.append(world, system);
  }

  const liveness = livenessText(server.connectionInfo);
  if (liveness) {
    const detail = document.createElement('p');
    detail.className = 'connection-card__meta';
    detail.textContent = liveness;
    card.append(detail);
  }

  if (server.active) {
    const active = document.createElement('span');
    active.className = 'active-marker';
    active.textContent = 'Default route';
    card.append(active);
  }
  return card;
}

function renderStatus(status: DesktopStatus): void {
  if (status.state !== 'online' || !status.status) {
    backendAlert.classList.remove('hidden');
    backendAlertMessage.textContent = status.message ?? 'The bridge service could not be reached.';
    connections.replaceChildren();
    return;
  }

  backendAlert.classList.add('hidden');
  const cards = status.status.servers.map(connectionCard);
  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No server profiles are configured.';
    connections.replaceChildren(empty);
  } else {
    connections.replaceChildren(...cards);
  }
}

function currentProfile(): EditableServerProfile | null {
  if (!editorConfig || !selectedName) return null;
  return editorConfig.servers[selectedName] ?? null;
}

function effectiveTokenConfigured(name: string, profile: EditableServerProfile): boolean {
  const update = tokenUpdates[name] ?? { mode: 'keep' };
  if (update.mode === 'replace') return update.value.length > 0;
  if (update.mode === 'clear') return false;
  return profile.authTokenConfigured;
}

function previewValue(): EditableServersConfig | null {
  if (!editorConfig) return null;
  return {
    ...editorConfig,
    servers: Object.fromEntries(
      Object.entries(editorConfig.servers).map(([name, profile]) => [
        name,
        { ...profile, authTokenConfigured: effectiveTokenConfigured(name, profile) },
      ])
    ),
  };
}

function renderPreview(): void {
  const value = previewValue();
  configPreview.textContent = value ? redactedJsonPreview(value) : '';
}

function markDirty(): void {
  dirty = true;
  editorMessage.textContent = 'Unsaved changes';
  renderPreview();
}

function setInputValue(field: string, value: unknown): void {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-profile-field="${field}"]`
  );
  if (!input) return;
  if (input instanceof HTMLInputElement && input.type === 'checkbox') {
    input.checked = field === 'rejectUnauthorized' ? value !== false : value === true;
  } else {
    input.value = value === undefined ? '' : String(value);
  }
}

function renderProfileList(): void {
  if (!editorConfig) {
    profileList.replaceChildren();
    return;
  }
  const buttons = Object.entries(editorConfig.servers).map(([name, profile]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.profileName = name;
    button.setAttribute('aria-current', String(name === selectedName));
    const label = document.createElement('span');
    label.textContent = profile.label || name;
    button.append(label);
    if (editorConfig?.defaultServer === name) {
      const marker = document.createElement('small');
      marker.textContent = 'Default';
      button.append(marker);
    }
    return button;
  });
  profileList.replaceChildren(...buttons);
}

function renderTokenEditor(name: string, profile: EditableServerProfile): void {
  const update = tokenUpdates[name] ?? { mode: 'keep' };
  const keepOption = tokenAction.querySelector<HTMLOptionElement>('option[value="keep"]')!;
  keepOption.disabled = !profile.authTokenConfigured;
  tokenAction.value =
    update.mode === 'keep' && !profile.authTokenConfigured ? 'clear' : update.mode;
  replacementTokenRow.classList.toggle('hidden', tokenAction.value !== 'replace');
  replacementToken.value = update.mode === 'replace' ? update.value : '';
  tokenState.textContent = profile.authTokenConfigured
    ? 'A secret is saved. Its value remains only in the main process.'
    : 'No secret is currently saved for this profile.';
}

function renderProfileEditor(): void {
  const profile = currentProfile();
  const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    '[data-profile-field]'
  );
  const disabled = !profile || !selectedName || !editorConfig;
  for (const control of controls) control.disabled = disabled;
  tokenAction.disabled = disabled;
  replacementToken.disabled = disabled;
  setDefaultButton.disabled = disabled || editorConfig?.defaultServer === selectedName;
  duplicateButton.disabled = disabled;
  deleteButton.disabled = disabled || Object.keys(editorConfig?.servers ?? {}).length <= 1;
  selectedProfileName.textContent = selectedName ?? '—';
  if (!profile || !selectedName) return;

  for (const field of [
    'label',
    'host',
    'port',
    'namespace',
    'reconnectAttempts',
    'reconnectDelay',
    'connectionTimeout',
    'connectionType',
    'protocol',
    'remoteMode',
    'rejectUnauthorized',
  ] as const) {
    setInputValue(field, profile[field]);
  }
  renderTokenEditor(selectedName, profile);
  renderPreview();
}

function selectProfile(name: string): void {
  if (!editorConfig?.servers[name]) return;
  selectedName = name;
  renderProfileList();
  renderProfileEditor();
}

async function loadConfig(): Promise<void> {
  editorMessage.textContent = 'Loading connection profiles…';
  try {
    const snapshot = await api.getConnectionsConfig();
    configHash = snapshot.hash;
    configPath.textContent = snapshot.path;
    editorConfig = snapshot.value;
    replacingInvalidConfig = !snapshot.valid;
    invalidConfigAlert.classList.toggle('hidden', snapshot.valid);
    invalidConfigError.textContent = snapshot.error ?? '';
    tokenUpdates = Object.fromEntries(
      Object.entries(snapshot.value.servers).map(([name, profile]) => [
        name,
        profile.authTokenConfigured ? { mode: 'keep' } : { mode: 'clear' },
      ])
    );
    const names = Object.keys(snapshot.value.servers);
    selectedName =
      (snapshot.value.defaultServer && snapshot.value.servers[snapshot.value.defaultServer]
        ? snapshot.value.defaultServer
        : names[0]) ?? null;
    dirty = false;
    editorMessage.textContent = snapshot.valid
      ? 'Saved secrets remain hidden.'
      : 'Review the safe replacement configuration, then save to repair the file.';
    renderProfileList();
    renderProfileEditor();
  } catch (error) {
    editorMessage.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function saveConfig(): Promise<void> {
  if (!editorConfig) return;
  saveButton.disabled = true;
  editorMessage.textContent = 'Validating and applying…';
  try {
    const result = await api.saveConnectionsConfig({
      value: editorConfig,
      expectedHash: configHash,
      authTokenUpdates: tokenUpdates,
      replaceInvalid: replacingInvalidConfig,
    });
    configHash = result.hash;
    editorConfig = result.value;
    replacingInvalidConfig = false;
    invalidConfigAlert.classList.add('hidden');
    tokenUpdates = Object.fromEntries(
      Object.entries(result.value.servers).map(([name, profile]) => [
        name,
        profile.authTokenConfigured ? { mode: 'keep' } : { mode: 'clear' },
      ])
    );
    dirty = false;
    if (result.applied) {
      editorMessage.textContent = result.changed
        ? 'Saved. Connection listeners reloaded.'
        : 'No file changes. Connection listeners reloaded.';
    } else {
      const prefix = result.changed ? 'Saved to disk' : 'No file changes';
      editorMessage.textContent = `${prefix}, but the backend could not apply the configuration: ${result.applyError ?? 'unknown backend error'}`;
    }
    renderProfileList();
    renderProfileEditor();
  } catch (error) {
    editorMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    saveButton.disabled = false;
  }
}

function updateProfileField(control: HTMLInputElement | HTMLSelectElement): void {
  const profile = currentProfile();
  const field = control.dataset.profileField;
  if (!profile || !field) return;
  const mutable = profile as unknown as Record<string, unknown>;
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    mutable[field] = control.checked;
  } else if (control.dataset.valueType === 'number') {
    if (control.value === '') delete mutable[field];
    else mutable[field] = Number(control.value);
  } else if (control.value === '') {
    delete mutable[field];
  } else {
    mutable[field] = control.value;
  }
  markDirty();
  if (field === 'label') renderProfileList();
}

function uniqueProfileName(base: string): string {
  if (!editorConfig) return base;
  let candidate = base;
  let suffix = 2;
  while (editorConfig.servers[candidate]) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function nextAvailablePort(): number {
  const used = new Set<number>();
  for (const profile of Object.values(editorConfig?.servers ?? {})) {
    const port = profile.port ?? 31415;
    used.add(port);
    if ((profile.connectionType ?? 'auto') !== 'websocket') used.add(port + 1);
  }
  for (let port = 31415; port < 65535; port += 1) {
    if (!used.has(port) && !used.has(port + 1)) return port;
  }
  return 31415;
}

function addProfile(name: string): void {
  if (!editorConfig) return;
  editorConfig.servers[name] = {
    label: name,
    host: 'localhost',
    port: nextAvailablePort(),
    connectionType: 'auto',
    remoteMode: false,
    authTokenConfigured: false,
  };
  tokenUpdates[name] = { mode: 'clear' };
  if (!editorConfig.defaultServer) editorConfig.defaultServer = name;
  selectedName = name;
  markDirty();
  renderProfileList();
  renderProfileEditor();
}

async function refreshStatus(): Promise<void> {
  refreshStatusButton.disabled = true;
  try {
    renderStatus(await api.getStatus());
  } catch (error) {
    renderStatus({
      state: 'offline',
      checkedAt: new Date().toISOString(),
      status: null,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    refreshStatusButton.disabled = false;
  }
}

profileList.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-profile-name]');
  if (button?.dataset.profileName) selectProfile(button.dataset.profileName);
});

for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
  '[data-profile-field]'
)) {
  control.addEventListener('input', () => updateProfileField(control));
  control.addEventListener('change', () => updateProfileField(control));
}

tokenAction.addEventListener('change', () => {
  const profile = currentProfile();
  if (!selectedName || !profile) return;
  if (tokenAction.value === 'replace') tokenUpdates[selectedName] = { mode: 'replace', value: '' };
  else if (tokenAction.value === 'clear') tokenUpdates[selectedName] = { mode: 'clear' };
  else tokenUpdates[selectedName] = { mode: 'keep' };
  renderTokenEditor(selectedName, profile);
  markDirty();
  if (tokenAction.value === 'replace') replacementToken.focus();
});

replacementToken.addEventListener('input', () => {
  if (!selectedName) return;
  tokenUpdates[selectedName] = { mode: 'replace', value: replacementToken.value };
  markDirty();
});

setDefaultButton.addEventListener('click', () => {
  if (!editorConfig || !selectedName) return;
  editorConfig.defaultServer = selectedName;
  markDirty();
  renderProfileList();
  renderProfileEditor();
});

element<HTMLButtonElement>('add-profile').addEventListener('click', () => {
  newProfileName.value = '';
  newProfileError.textContent = '';
  addProfileDialog.showModal();
  newProfileName.focus();
});

element<HTMLButtonElement>('cancel-add-profile').addEventListener('click', () =>
  addProfileDialog.close()
);

element<HTMLButtonElement>('confirm-add-profile').addEventListener('click', () => {
  const name = newProfileName.value.trim();
  if (!name) {
    newProfileError.textContent = 'Enter a profile name.';
    return;
  }
  if (editorConfig?.servers[name]) {
    newProfileError.textContent = 'That profile name is already in use.';
    return;
  }
  addProfileDialog.close();
  addProfile(name);
});

duplicateButton.addEventListener('click', () => {
  const profile = currentProfile();
  if (!editorConfig || !selectedName || !profile) return;
  const name = uniqueProfileName(`${selectedName}-copy`);
  editorConfig.servers[name] = {
    ...profile,
    label: profile.label ? `${profile.label} Copy` : name,
    port: nextAvailablePort(),
    authTokenConfigured: false,
  };
  tokenUpdates[name] = { mode: 'clear' };
  selectedName = name;
  markDirty();
  renderProfileList();
  renderProfileEditor();
});

deleteButton.addEventListener('click', () => {
  if (!editorConfig || !selectedName || Object.keys(editorConfig.servers).length <= 1) return;
  if (!window.confirm(`Delete the "${selectedName}" connection profile?`)) return;
  const removed = selectedName;
  delete editorConfig.servers[removed];
  delete tokenUpdates[removed];
  const next = Object.keys(editorConfig.servers)[0];
  if (!next) return;
  if (editorConfig.defaultServer === removed) editorConfig.defaultServer = next;
  selectedName = next;
  markDirty();
  renderProfileList();
  renderProfileEditor();
});

element<HTMLButtonElement>('edit-connections').addEventListener('click', () =>
  setView('connections')
);
element<HTMLButtonElement>('back-to-overview').addEventListener('click', () => {
  if (dirty && !window.confirm('Leave without saving your connection changes?')) return;
  setView('overview');
});
saveButton.addEventListener('click', () => void saveConfig());
element<HTMLButtonElement>('open-config-folder').addEventListener(
  'click',
  () => void api.openConfigFolder()
);
refreshStatusButton.addEventListener('click', () => void refreshStatus());
api.onNavigate(setView);
api.onStatusChanged(renderStatus);

void api
  .getStatus()
  .then(renderStatus)
  .catch(error => {
    renderStatus({
      state: 'offline',
      checkedAt: new Date().toISOString(),
      status: null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
