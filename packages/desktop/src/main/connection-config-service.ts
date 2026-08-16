import type {
  BackendStatusResult,
  DesktopStatus,
  SaveConnectionsRequest,
  SaveConnectionsResult,
  ServersConfig,
} from '../shared/contracts.js';
import type { ConfigStore } from './config-store.js';
import { maskServersConfig, materializeServersConfig } from './editable-config.js';

export interface ConnectionConfigControl {
  getStatus(): Promise<BackendStatusResult>;
  reloadServersConfig(): Promise<unknown>;
}

export interface ConnectionConfigSupervisor {
  ensureRunning(): Promise<DesktopStatus>;
  refresh(): Promise<DesktopStatus>;
}

export interface ConnectionConfigDependencies {
  configStore: ConfigStore<ServersConfig>;
  control: ConnectionConfigControl;
  supervisor: ConnectionConfigSupervisor;
  matchesManagedBackend(status: BackendStatusResult): boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeManagedBackend(
  dependencies: ConnectionConfigDependencies
): Promise<BackendStatusResult | null> {
  try {
    const status = await dependencies.control.getStatus();
    return dependencies.matchesManagedBackend(status) ? status : null;
  } catch {
    return null;
  }
}

async function requireManagedBackend(
  dependencies: ConnectionConfigDependencies
): Promise<BackendStatusResult> {
  const status = await dependencies.control.getStatus();
  if (!dependencies.matchesManagedBackend(status)) {
    throw new Error('The backend on the control port is not managed by this desktop installation');
  }
  return status;
}

function requireManagedDesktopStatus(
  status: DesktopStatus,
  dependencies: ConnectionConfigDependencies
): BackendStatusResult {
  if (
    status.state !== 'online' ||
    !status.status ||
    !dependencies.matchesManagedBackend(status.status)
  ) {
    throw new Error(status.message ?? 'The managed backend did not become available');
  }
  return status.status;
}

async function ensureManagedBackend(
  dependencies: ConnectionConfigDependencies,
  managedHint: BackendStatusResult | null
): Promise<BackendStatusResult> {
  if (!managedHint) {
    requireManagedDesktopStatus(await dependencies.supervisor.ensureRunning(), dependencies);
  }
  try {
    return await requireManagedBackend(dependencies);
  } catch (error) {
    // The backend can disappear between the save-time probe and application.
    // Give the supervisor one chance to restore the exact managed daemon.
    if (!managedHint) throw error;
    requireManagedDesktopStatus(await dependencies.supervisor.ensureRunning(), dependencies);
    return requireManagedBackend(dependencies);
  }
}

async function applyManagedConfig(
  dependencies: ConnectionConfigDependencies,
  managedHint: BackendStatusResult | null
): Promise<void> {
  await ensureManagedBackend(dependencies, managedHint);
  await dependencies.control.reloadServersConfig();
  requireManagedDesktopStatus(await dependencies.supervisor.refresh(), dependencies);
}

async function restoreManagedConfig(dependencies: ConnectionConfigDependencies): Promise<void> {
  // ConfigStore has restored the prior bytes before calling this hook. Try to
  // bring back the exact managed daemon as well, then reload those prior bytes.
  const managedAfterRestore = await probeManagedBackend(dependencies);
  await ensureManagedBackend(dependencies, managedAfterRestore);
  await dependencies.control.reloadServersConfig();
  requireManagedDesktopStatus(await dependencies.supervisor.refresh(), dependencies);
}

/**
 * Save the renderer-safe profile model and confirm that the managed backend
 * has loaded it. Changed bytes are committed only if the exact managed backend
 * starts (when necessary), reloads them, and remains reachable. Any failure
 * restores the prior bytes and makes a best-effort reload of the prior registry.
 */
export async function saveAndApplyConnections(
  request: SaveConnectionsRequest,
  dependencies: ConnectionConfigDependencies
): Promise<SaveConnectionsResult> {
  const inspection = await dependencies.configStore.inspect();
  if (inspection.valid && request.replaceInvalid) {
    throw new Error('Refusing invalid-file recovery because the configuration is now valid');
  }
  if (!inspection.valid && !request.replaceInvalid) {
    throw new Error('The invalid configuration must be explicitly replaced');
  }

  const candidate = materializeServersConfig(
    request.value,
    inspection.valid ? inspection.value : null,
    request.authTokenUpdates
  );
  const managedBeforeSave = await probeManagedBackend(dependencies);
  let appliedDuringSave = false;

  const result = await dependencies.configStore.save(candidate, {
    expectedHash: request.expectedHash,
    allowInvalidPrevious: !inspection.valid,
    hooks: {
      apply: async () => {
        await applyManagedConfig(dependencies, managedBeforeSave);
        appliedDuringSave = true;
      },
      rollback: async () => restoreManagedConfig(dependencies),
    },
  });

  let applied = appliedDuringSave;
  let applyError: string | undefined;
  try {
    if (!appliedDuringSave) {
      // This is intentionally unconditional for an unchanged file: the user
      // clicked “Save and reload,” and the live registry may lag a manual edit.
      await applyManagedConfig(dependencies, managedBeforeSave);
    }
    applied = true;
  } catch (error) {
    applied = false;
    applyError = errorMessage(error);
  }

  return {
    ...result,
    valid: true,
    value: maskServersConfig(result.value),
    applied,
    ...(applyError !== undefined ? { applyError } : {}),
  };
}
