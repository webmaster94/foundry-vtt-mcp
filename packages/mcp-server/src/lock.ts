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

/** Lock files older than this are treated as stale even if a node process holds the PID. */
export const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Node.js executable names across platforms.
 * Includes the "nodejs" variant shipped by some Linux distro package managers.
 */
const NODE_PROCESS_NAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe']);

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
 * Decides whether an existing lock file whose PID is alive should be treated
 * as **valid** (the real backend is running) or **orphaned** (stale lock that
 * should be cleared).
 *
 * Decision rules (in order):
 *  1. If the process is not a Node.js executable → **orphaned**
 *     (covers PID reuse by unrelated system processes, e.g. GameInputRedistService)
 *  2. If the lock file is older than `maxAgeMs` → **orphaned**
 *     (covers the edge case where a different node.exe reused the PID)
 *  3. Otherwise → **valid** (the backend is genuinely running)
 *
 * The `checkProcessName` and `checkStaleness` parameters exist solely for
 * dependency injection in unit tests — callers should omit them in production.
 */
export function evaluateLockFile(
  lockPid: number,
  lockFilePath: string,
  {
    maxAgeMs = LOCK_MAX_AGE_MS,
    checkProcessName = isNodeProcess,
    checkStaleness = isLockStale,
  }: {
    maxAgeMs?: number;
    checkProcessName?: (pid: number) => boolean;
    checkStaleness?: (filePath: string, maxAgeMs?: number) => boolean;
  } = {}
): 'valid' | 'orphaned' {
  if (!checkProcessName(lockPid)) {
    return 'orphaned';
  }
  if (checkStaleness(lockFilePath, maxAgeMs)) {
    return 'orphaned';
  }
  return 'valid';
}
