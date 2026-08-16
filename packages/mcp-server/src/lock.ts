/**
 * Lock-file helpers for the backend singleton guard.
 *
 * Extracted into their own module so they can be unit-tested without
 * importing (and executing) the full backend.ts entry point.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retained for diagnostics/backward API compatibility; age alone never invalidates a live daemon. */
export const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Node.js executable names across platforms.
 * Includes the "nodejs" variant shipped by some Linux distro package managers.
 */
const NODE_PROCESS_NAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe']);

export interface BackendLockIdentity {
  pid: number;
  instanceId: string;
  startedAt: string;
  entryPath: string;
}

export type BackendLockAcquisition =
  | { acquired: true; fd: number }
  | { acquired: false; existing: BackendLockIdentity };

export interface BackendLockAcquisitionOptions {
  /** Give the process that created an empty lock time to write its identity. */
  initializationGraceMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  evaluateIdentity?: (identity: BackendLockIdentity, lockFilePath: string) => 'valid' | 'orphaned';
}

/** Parse current JSON identities and legacy PID-only lock files. */
export function parseBackendLockIdentity(contents: string): BackendLockIdentity | null {
  const trimmed = contents.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 0
      ? { pid, instanceId: `legacy-${pid}`, startedAt: '', entryPath: '' }
      : null;
  }

  try {
    const value = JSON.parse(trimmed) as Partial<BackendLockIdentity>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.instanceId !== 'string' ||
      value.instanceId.length === 0 ||
      typeof value.startedAt !== 'string' ||
      typeof value.entryPath !== 'string'
    ) {
      return null;
    }
    return {
      pid: value.pid!,
      instanceId: value.instanceId,
      startedAt: value.startedAt,
      entryPath: value.entryPath,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function removeLockIfUnchanged(lockFilePath: string, expectedContents: string): void {
  try {
    if (fs.readFileSync(lockFilePath, 'utf8') !== expectedContents) return;
    fs.unlinkSync(lockFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

/**
 * Atomically claim the backend lock while tolerating the brief interval
 * between another process creating the file and writing its identity.
 */
export async function acquireBackendLockFile(
  lockFilePath: string,
  identity: BackendLockIdentity,
  options: BackendLockAcquisitionOptions = {}
): Promise<BackendLockAcquisition> {
  const initializationGraceMs = options.initializationGraceMs ?? 1_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const checkProcess = options.isProcessAlive ?? isProcessAlive;
  const evaluate = options.evaluateIdentity ?? evaluateLockFile;
  let invalidLockDeadline: number | null = null;

  while (true) {
    let fd: number;
    try {
      fd = fs.openSync(lockFilePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;

      let observedContents: string;
      try {
        observedContents = fs.readFileSync(lockFilePath, 'utf8');
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException)?.code === 'ENOENT') {
          invalidLockDeadline = null;
          continue;
        }
        throw readError;
      }

      const existing = parseBackendLockIdentity(observedContents);
      if (!existing) {
        let recentlyCreated = true;
        try {
          recentlyCreated = now() - fs.statSync(lockFilePath).mtimeMs < initializationGraceMs;
        } catch {
          // If metadata raced with replacement, use the same bounded grace.
        }

        if (recentlyCreated) {
          invalidLockDeadline ??= now() + initializationGraceMs;
          if (now() < invalidLockDeadline) {
            await wait(Math.min(retryDelayMs, Math.max(invalidLockDeadline - now(), 1)));
            continue;
          }
        }

        invalidLockDeadline = null;
        removeLockIfUnchanged(lockFilePath, observedContents);
        continue;
      }

      invalidLockDeadline = null;
      if (checkProcess(existing.pid) && evaluate(existing, lockFilePath) === 'valid') {
        return { acquired: false, existing };
      }

      removeLockIfUnchanged(lockFilePath, observedContents);
      continue;
    }

    try {
      fs.writeFileSync(fd, JSON.stringify(identity));
      try {
        fs.fsyncSync(fd);
      } catch {
        // The identity is still usable when a filesystem does not support fsync.
      }
      return { acquired: true, fd };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.unlinkSync(lockFilePath);
      } catch {}
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// getProcessName
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase base name of the executable owning the given PID,
 * or `null` if the process cannot be identified (not found, access denied,
 * query tool missing, etc.).
 *
 * Platform behaviour:
 *  - **Windows**: runs `tasklist /FI "PID eq <pid>" /FO CSV /NH` and parses
 *    the first CSV field of the returned row (e.g. `"node.exe"`).
 *  - **Linux**: reads `/proc/<pid>/comm` (no subprocess).  Falls back to
 *    `ps -p <pid> -o comm=` if `/proc` is unavailable.
 *  - **macOS / other POSIX**: runs `ps -p <pid> -o comm=` and extracts the
 *    basename (the field can be a full path on macOS).
 */
export function getProcessName(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      });
      // A matching row looks like: "node.exe","12345","Console","1","3,028 K"
      // Non-matching output:       INFO: No tasks are running…
      const match = output.match(/^"([^"]+)"/m);
      if (!match) return null;
      return match[1].toLowerCase();
    }

    if (process.platform === 'linux') {
      // /proc/<pid>/comm is the fastest path — no subprocess required
      const commPath = `/proc/${pid}/comm`;
      if (fs.existsSync(commPath)) {
        return fs.readFileSync(commPath, 'utf8').trim().toLowerCase();
      }
      // Fall through to ps if /proc is unavailable (e.g. container edge cases)
    }

    // macOS + Linux fallback
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    // On macOS, comm= can be a full path; extract the basename
    return path.basename(output.trim()).toLowerCase();
  } catch {
    // Process not found, permission denied, tool missing, etc.
    return null;
  }
}

/** Best-effort process command line used to distinguish our backend from PID reuse. */
export function getProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true }
      );
      const value = output.trim();
      return value || null;
    }

    if (process.platform === 'linux') {
      const commandLinePath = `/proc/${pid}/cmdline`;
      if (fs.existsSync(commandLinePath)) {
        const value = fs.readFileSync(commandLinePath).toString('utf8').replace(/\0/g, ' ').trim();
        return value || null;
      }
    }

    const output = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    const value = output.trim();
    return value || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// isNodeProcess
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given PID is running under a Node.js executable.
 * Returns `false` on any error (process not found, query failure, etc.).
 *
 * `getName` is injectable so the membership logic can be tested without
 * depending on the live test runner's process name (which `ps -o comm=`
 * reports as the process *title* on macOS, e.g. "node (vitest 1)").
 */
export function isNodeProcess(
  pid: number,
  getName: (pid: number) => string | null = getProcessName
): boolean {
  const name = getName(pid);
  return name !== null && NODE_PROCESS_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// isLockStale
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the lock file's `mtime` is older than `maxAgeMs`
 * (default: {@link LOCK_MAX_AGE_MS}).
 *
 * Returns `false` if the file cannot be stat'd (missing, permission error).
 */
export function isLockStale(lockFilePath: string, maxAgeMs: number = LOCK_MAX_AGE_MS): boolean {
  try {
    const stat = fs.statSync(lockFilePath);
    return Date.now() - stat.mtimeMs >= maxAgeMs;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// evaluateLockFile — pure, testable decision function
// ---------------------------------------------------------------------------

/**
 * Decides whether an existing lock whose PID is alive should be treated
 * as **valid** (the real backend is running) or **orphaned** (stale lock that
 * should be cleared).
 *
 * Decision rules (in order):
 *  1. For current JSON locks, when the process command line is available it
 *     must reference the exact backend entry path. The executable itself may
 *     be Node, Electron-as-Node, or another packaged Node runtime.
 *  2. If a current lock's command line cannot be inspected, fail safe as
 *     **valid** so a transient inspection failure cannot create two backends.
 *  3. Legacy PID-only locks must still belong to a Node-named executable.
 *  4. Lock age alone never invalidates a live persistent daemon.
 *
 * The `checkProcessName` and `readCommandLine` parameters exist solely for
 * dependency injection in unit tests — callers should omit them in production.
 */
export function evaluateLockFile(
  lock: number | BackendLockIdentity,
  _lockFilePath: string,
  {
    checkProcessName = isNodeProcess,
    readCommandLine = getProcessCommandLine,
  }: {
    checkProcessName?: (pid: number) => boolean;
    readCommandLine?: (pid: number) => string | null;
  } = {}
): 'valid' | 'orphaned' {
  const identity: BackendLockIdentity =
    typeof lock === 'number'
      ? { pid: lock, instanceId: `legacy-${lock}`, startedAt: '', entryPath: '' }
      : lock;

  if (identity.entryPath) {
    const commandLine = readCommandLine(identity.pid);
    if (commandLine === null) return 'valid';

    const normalize = (value: string): string =>
      (process.platform === 'win32' ? value.toLowerCase() : value).replace(/\\/g, '/');
    return normalize(commandLine).includes(normalize(path.resolve(identity.entryPath)))
      ? 'valid'
      : 'orphaned';
  }

  return checkProcessName(identity.pid) ? 'valid' : 'orphaned';
}
