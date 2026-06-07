/**
 * Unit tests for lock-file helpers (src/lock.ts).
 *
 * All tests use the injected `checkProcessName` / `checkStaleness` parameters
 * of `evaluateLockFile` so that no child-process or filesystem calls are made.
 * The lower-level helpers (`isLockStale`, `getProcessName`) are tested with
 * real temporary files and vi.mock where needed.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateLockFile, isLockStale, isNodeProcess, getProcessName, LOCK_MAX_AGE_MS } from './lock.js';

// ---------------------------------------------------------------------------
// evaluateLockFile — the four core scenarios from the bug report
// ---------------------------------------------------------------------------

describe('evaluateLockFile', () => {

  const FAKE_LOCK = '/tmp/test-foundry-backend.lock';

  // Test 1: PID belongs to a non-Node process (e.g. GameInputRedistService)
  it('returns "orphaned" when process is not node.exe (PID reuse by OS service)', () => {
    const result = evaluateLockFile(26188, FAKE_LOCK, {
      checkProcessName: (_pid) => false,   // not a node process
      checkStaleness:   (_p)   => false,   // lock file is fresh
    });
    expect(result).toBe('orphaned');
  });

  // Test 2: PID belongs to a live node process with a fresh lock file
  it('returns "valid" when process is node.exe and lock file is fresh', () => {
    const result = evaluateLockFile(12345, FAKE_LOCK, {
      checkProcessName: (_pid) => true,    // node process alive
      checkStaleness:   (_p)   => false,   // lock file is fresh
    });
    expect(result).toBe('valid');
  });

  // Test 3: PID does not exist — process.kill throws ESRCH → caught upstream,
  // this path is never reached. evaluateLockFile is only called AFTER
  // process.kill(pid, 0) succeeds. We verify the function handles a
  // "non-existent PID" gracefully if checkProcessName returns false.
  it('returns "orphaned" when checkProcessName returns false for a non-existent PID', () => {
    const result = evaluateLockFile(99999, FAKE_LOCK, {
      checkProcessName: (_pid) => false,   // getProcessName would return null for dead PIDs
      checkStaleness:   (_p)   => false,
    });
    expect(result).toBe('orphaned');
  });

  // Test 4: Lock file older than 60 minutes (stale), even if process is node
  it('returns "orphaned" when lock file is stale (> 60 min) even if process is node.exe', () => {
    const result = evaluateLockFile(12345, FAKE_LOCK, {
      checkProcessName: (_pid) => true,    // node process alive
      checkStaleness:   (_p)   => true,    // lock file is stale
    });
    expect(result).toBe('orphaned');
  });

  // Edge: both checks fail simultaneously
  it('returns "orphaned" when process is not node AND lock file is stale', () => {
    const result = evaluateLockFile(26188, FAKE_LOCK, {
      checkProcessName: () => false,
      checkStaleness:   () => true,
    });
    expect(result).toBe('orphaned');
  });

  // Custom maxAgeMs is forwarded to checkStaleness
  it('forwards custom maxAgeMs to checkStaleness', () => {
    const checkStaleness = vi.fn().mockReturnValue(false);
    evaluateLockFile(1, FAKE_LOCK, {
      checkProcessName: () => true,
      checkStaleness,
      maxAgeMs: 999,
    });
    expect(checkStaleness).toHaveBeenCalledWith(FAKE_LOCK, 999);
  });

});

// ---------------------------------------------------------------------------
// isLockStale — real filesystem, controlled mtime
// ---------------------------------------------------------------------------

describe('isLockStale', () => {

  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test-lock-${Date.now()}.lock`);
    fs.writeFileSync(tmpFile, '1');
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('returns false for a freshly created file', () => {
    expect(isLockStale(tmpFile, LOCK_MAX_AGE_MS)).toBe(false);
  });

  it('returns false when maxAgeMs is larger than file age', () => {
    expect(isLockStale(tmpFile, 10 * 60 * 1000 /* 10 min */)).toBe(false);
  });

  it('returns true when file mtime is older than maxAgeMs', () => {
    // Back-date the file's mtime to 61 minutes ago
    const sixtyOneMinutesAgo = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(tmpFile, sixtyOneMinutesAgo, sixtyOneMinutesAgo);
    expect(isLockStale(tmpFile, LOCK_MAX_AGE_MS)).toBe(true);
  });

  it('returns false (safe default) when the file does not exist', () => {
    expect(isLockStale('/nonexistent/path/lock.pid', LOCK_MAX_AGE_MS)).toBe(false);
  });

  it('uses LOCK_MAX_AGE_MS as default when maxAgeMs is omitted', () => {
    const sixtyOneMinutesAgo = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(tmpFile, sixtyOneMinutesAgo, sixtyOneMinutesAgo);
    // Should use the 60-min default
    expect(isLockStale(tmpFile)).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// isNodeProcess — mocks getProcessName via vi.mock
// ---------------------------------------------------------------------------

describe('isNodeProcess', () => {

  it('returns true for every recognized node executable name', () => {
    // Inject the name resolver so the result does not depend on the live
    // runner's process name (macOS `ps -o comm=` reports the process title,
    // which under vitest is "node (vitest N)", not "node").
    for (const name of ['node', 'node.exe', 'nodejs', 'nodejs.exe']) {
      expect(isNodeProcess(1234, () => name)).toBe(true);
    }
  });

  it('returns false for a non-node process name', () => {
    expect(isNodeProcess(1234, () => 'chrome')).toBe(false);
    expect(isNodeProcess(1234, () => 'node (vitest 1)')).toBe(false);
  });

  it('returns false when the process name cannot be resolved', () => {
    expect(isNodeProcess(1234, () => null)).toBe(false);
  });

  it('returns false for a non-existent PID (real resolver)', () => {
    // Very large PID that is extremely unlikely to exist
    expect(isNodeProcess(9_999_999)).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// getProcessName — current process is always node
// ---------------------------------------------------------------------------

describe('getProcessName', () => {

  it('returns a node-related name for the current process PID', () => {
    const name = getProcessName(process.pid);
    // The test runner is Node.js; the process name must be node/node.exe/nodejs
    expect(name).toMatch(/^node/i);
  });

  it('returns null for a non-existent PID', () => {
    expect(getProcessName(9_999_999)).toBeNull();
  });

});
