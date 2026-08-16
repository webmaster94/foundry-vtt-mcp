import {
  AuthTokenUpdate,
  EditableServersConfig,
  ServerProfile,
  ServersConfig,
} from '../shared/contracts.js';

const PROFILE_KEYS = [
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
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function maskServersConfig(value: ServersConfig): EditableServersConfig {
  const servers = Object.fromEntries(
    Object.entries(value.servers).map(([name, profile]) => {
      const { authToken, ...safeProfile } = profile;
      return [
        name,
        {
          ...safeProfile,
          authTokenConfigured: typeof authToken === 'string' && authToken.length > 0,
        },
      ];
    })
  );
  return {
    ...(value.$comment !== undefined ? { $comment: value.$comment } : {}),
    ...(value.defaultServer !== undefined ? { defaultServer: value.defaultServer } : {}),
    servers,
  };
}

function readTokenUpdate(updates: Record<string, AuthTokenUpdate>, name: string): AuthTokenUpdate {
  const update = updates[name] ?? { mode: 'keep' };
  if (update.mode === 'keep' || update.mode === 'clear') return update;
  if (update.mode === 'replace' && typeof update.value === 'string') return update;
  throw new Error(`Invalid auth-token update for server profile "${name}"`);
}

/**
 * Converts the renderer-safe editor model back into a validation candidate.
 * Only explicitly allowed profile keys cross the IPC trust boundary. Existing
 * secrets remain in the main process unless the user chooses replace or clear.
 */
export function materializeServersConfig(
  editableValue: unknown,
  currentValue: ServersConfig | null,
  updatesValue: unknown
): unknown {
  if (!isRecord(editableValue) || !isRecord(editableValue.servers)) {
    throw new Error('Connection editor payload must contain a servers object');
  }
  if (!isRecord(updatesValue)) throw new Error('Connection editor token updates are invalid');
  const updates = updatesValue as Record<string, AuthTokenUpdate>;
  const servers: Record<string, Record<string, unknown>> = {};

  for (const [name, editableProfile] of Object.entries(editableValue.servers)) {
    if (!isRecord(editableProfile)) {
      servers[name] = {};
      continue;
    }
    const profile: Record<string, unknown> = {};
    for (const key of PROFILE_KEYS) {
      if (editableProfile[key] !== undefined) profile[key] = editableProfile[key];
    }

    const update = readTokenUpdate(updates, name);
    if (update.mode === 'replace') {
      profile.authToken = update.value;
    } else if (update.mode === 'keep') {
      const existing = currentValue?.servers[name]?.authToken;
      if (existing !== undefined) profile.authToken = existing;
    }
    servers[name] = profile;
  }

  return {
    ...(Object.prototype.hasOwnProperty.call(editableValue, '$comment')
      ? { $comment: editableValue.$comment }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(editableValue, 'defaultServer')
      ? { defaultServer: editableValue.defaultServer }
      : {}),
    servers,
  };
}

export function redactedJsonPreview(value: EditableServersConfig): string {
  const preview: ServersConfig = {
    ...(value.$comment !== undefined ? { $comment: value.$comment } : {}),
    ...(value.defaultServer !== undefined ? { defaultServer: value.defaultServer } : {}),
    servers: Object.fromEntries(
      Object.entries(value.servers).map(([name, profile]) => {
        const { authTokenConfigured, ...safeProfile } = profile;
        const previewProfile: ServerProfile = { ...safeProfile };
        if (authTokenConfigured) previewProfile.authToken = '<configured — hidden>';
        return [name, previewProfile];
      })
    ),
  };
  return `${JSON.stringify(preview, null, 2)}\n`;
}
