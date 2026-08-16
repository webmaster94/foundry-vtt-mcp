import { ServerProfile, ServersConfig } from '../shared/contracts.js';

export interface ConfigValidator<T> {
  (value: unknown): T;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid Foundry server configuration:\n${issues.map(issue => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    issues.push(`${path}.${key} must be a string`);
    return undefined;
  }
  return value;
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    issues.push(`${path}.${key} must be a boolean`);
    return undefined;
  }
  return value;
}

function optionalInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[]
): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push(`${path}.${key} must be an integer from ${minimum} through ${maximum}`);
    return undefined;
  }
  return value as number;
}

function validateProfile(value: unknown, path: string, issues: string[]): ServerProfile {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }

  const connectionType = optionalString(value, 'connectionType', path, issues);
  if (connectionType && !['auto', 'websocket', 'webrtc'].includes(connectionType)) {
    issues.push(`${path}.connectionType must be auto, websocket, or webrtc`);
  }
  const protocol = optionalString(value, 'protocol', path, issues);
  if (protocol && protocol !== 'ws' && protocol !== 'wss') {
    issues.push(`${path}.protocol must be ws or wss`);
  }

  const profile: ServerProfile = {};
  const label = optionalString(value, 'label', path, issues);
  const host = optionalString(value, 'host', path, issues);
  const port = optionalInteger(value, 'port', path, 1024, 65535, issues);
  const namespace = optionalString(value, 'namespace', path, issues);
  const reconnectAttempts = optionalInteger(value, 'reconnectAttempts', path, 1, 20, issues);
  const reconnectDelay = optionalInteger(value, 'reconnectDelay', path, 100, 30_000, issues);
  const connectionTimeout = optionalInteger(
    value,
    'connectionTimeout',
    path,
    1_000,
    60_000,
    issues
  );
  const remoteMode = optionalBoolean(value, 'remoteMode', path, issues);
  const rejectUnauthorized = optionalBoolean(value, 'rejectUnauthorized', path, issues);
  const authToken = optionalString(value, 'authToken', path, issues);

  if (host !== undefined && host.trim().length === 0) {
    issues.push(`${path}.host cannot be blank`);
  }

  if (remoteMode && (!authToken || authToken.trim().length < 16)) {
    issues.push(`${path}.authToken must contain at least 16 characters when remoteMode is enabled`);
  }

  if (label !== undefined) profile.label = label;
  if (host !== undefined) profile.host = host;
  if (port !== undefined) profile.port = port;
  if (namespace !== undefined) profile.namespace = namespace;
  if (reconnectAttempts !== undefined) profile.reconnectAttempts = reconnectAttempts;
  if (reconnectDelay !== undefined) profile.reconnectDelay = reconnectDelay;
  if (connectionTimeout !== undefined) profile.connectionTimeout = connectionTimeout;
  if (connectionType === 'auto' || connectionType === 'websocket' || connectionType === 'webrtc') {
    profile.connectionType = connectionType;
  }
  if (protocol === 'ws' || protocol === 'wss') profile.protocol = protocol;
  if (remoteMode !== undefined) profile.remoteMode = remoteMode;
  if (rejectUnauthorized !== undefined) profile.rejectUnauthorized = rejectUnauthorized;
  if (authToken !== undefined) profile.authToken = authToken;
  return profile;
}

export const validateServersConfig: ConfigValidator<ServersConfig> = value => {
  const issues: string[] = [];
  if (!isRecord(value)) throw new ConfigValidationError(['configuration root must be an object']);
  if (!isRecord(value.servers)) {
    throw new ConfigValidationError(['servers must be an object keyed by profile name']);
  }

  const serverEntries = Object.entries(value.servers);
  if (serverEntries.length === 0) issues.push('servers must contain at least one profile');

  const servers: Record<string, ServerProfile> = {};
  for (const [name, profileValue] of serverEntries) {
    if (!name.trim()) {
      issues.push('server profile names cannot be empty');
      continue;
    }
    servers[name] = validateProfile(profileValue, `servers.${name}`, issues);
  }

  const defaultServer = optionalString(value, 'defaultServer', 'configuration', issues);
  const comment = optionalString(value, '$comment', 'configuration', issues);

  const usedPorts = new Map<number, string>();
  for (const [name, profile] of Object.entries(servers)) {
    const mainPort = profile.port ?? 31415;
    const reservations = [mainPort];
    if ((profile.connectionType ?? 'auto') !== 'websocket') reservations.push(mainPort + 1);
    for (const port of reservations) {
      if (port > 65535) {
        issues.push(`servers.${name} requires signaling port ${port}, outside the valid range`);
        continue;
      }
      const owner = usedPorts.get(port);
      if (owner) issues.push(`servers.${name} port ${port} conflicts with ${owner}`);
      else usedPorts.set(port, `servers.${name}`);
    }
  }

  if (defaultServer !== undefined) {
    if (defaultServer.trim().length === 0) {
      issues.push('configuration.defaultServer cannot be blank');
    } else if (!Object.prototype.hasOwnProperty.call(servers, defaultServer)) {
      issues.push(
        `configuration.defaultServer must name an existing profile (received "${defaultServer}")`
      );
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return {
    ...(comment !== undefined ? { $comment: comment } : {}),
    ...(defaultServer !== undefined ? { defaultServer } : {}),
    servers,
  };
};

export function createDefaultServersConfig(): ServersConfig {
  return {
    defaultServer: 'default',
    servers: {
      default: {
        label: 'Local Foundry VTT',
        host: 'localhost',
        port: 31415,
        connectionType: 'auto',
        remoteMode: false,
      },
    },
  };
}
