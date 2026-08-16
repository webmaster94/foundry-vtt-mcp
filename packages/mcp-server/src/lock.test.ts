/**
 * Unit tests for lock-file helpers (src/lock.ts).
 *
 * All tests use the injected `checkProcessName` / `readCommandLine` parameters
 * of `evaluateLockFile` so that no child-process or filesystem calls are made.
 * The lower-level helpers (`isLockStale`, `getProcessName`) are tested with
 * real temporary files and vi.mock where needed.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireBackendLockFile,
  evaluateLockFile,
  isLockStale,
  isNodeProcess,
  getProcessName,
  parseBackendLockIdentity,
  LOCK_MAX_AGE_MS,
} from './lock.js';

// ---------------------------------------------------------------------------
// evaluateLockFile — the four core scenarios from the bug report
// ---------------------------------------------------------------------------

describe('evaluateLockFile', () => {
  const FAKE_LOCK = '/tmp/test-foundry-backend.lock';

  // Test 1: PID belongs to a non-Node process (e.g. GameInputRedistService)
  it('returns "orphaned" when process is not node.exe (PID reuse by OS service)', () => {
    const result = evaluateLockFile(26188, FAKE_LOCK, {
      checkProcessName: _pid => false, // not a node process
    });
    expect(result).toBe('orphaned');
  });

  // Test 2: PID belongs to a live node process
  it('returns "valid" for a live legacy node PID regardless of lock age', () => {
    const result = evaluateLockFile(12345, FAKE_LOCK, {
      checkProcessName: _pid => true, // node process alive
    });
    expect(result).toBe('valid');
  });

  // Test 3: PID does not exist — process.kill throws ESRCH → caught upstream,
  // this path is never reached. evaluateLockFile is only called AFTER
  // process.kill(pid, 0) succeeds. We verify the function handles a
  // "non-existent PID" gracefully if checkProcessName returns false.
  it('returns "orphaned" when checkProcessName returns false for a non-existent PID', () => {
    const result = evaluateLockFile(99999, FAKE_LOCK, {
      checkProcessName: _pid => false, // getProcessName would return null for dead PIDs
    });
    expect(result).toBe('orphaned');
  });

  it('accepts an hours-old verified backend identity', () => {
    const entryPath = path.resolve('backend.js');
    const result = evaluateLockFile(
      {
        pid: 12345,
        instanceId: 'instance-a',
        startedAt: '2026-01-01T00:00:00.000Z',
        entryPath,
      },
      FAKE_LOCK,
      {
        checkProcessName: () => true,
        readCommandLine: () => `node "${entryPath}"`,
      }
    );
    expect(result).toBe('valid');
  });

  it('accepts a packaged Electron-as-Node runtime when its command line owns the entry path', () => {
    const entryPath = path.resolve('backend.bundle.cjs');
    const checkProcessName = vi.fn().mockReturnValue(false);
    const result = evaluateLockFile(
      {
        pid: 12345,
        instanceId: 'packaged-instance',
        startedAt: '2026-01-01T00:00:00.000Z',
        entryPath,
      },
      FAKE_LOCK,
      {
        checkProcessName,
        readCommandLine: () => `"FoundryVTT MCP Bridge.exe" "${entryPath}"`,
      }
    );
    expect(result).toBe('valid');
    expect(checkProcessName).not.toHaveBeenCalled();
  });

  it('rejects a reused Node PID whose command line points at another program', () => {
    const result = evaluateLockFile(
      {
        pid: 12345,
        instanceId: 'instance-a',
        startedAt: '2026-01-01T00:00:00.000Z',
        entryPath: '/srv/foundry/backend.js',
      },
      FAKE_LOCK,
      {
        checkProcessName: () => true,
        readCommandLine: () => 'node /srv/unrelated/worker.js',
      }
    );
    expect(result).toBe('orphaned');
  });

  it('fails safe when a live Node command line cannot be inspected', () => {
    const result = evaluateLockFile(
      {
        pid: 12345,
        instanceId: 'instance-a',
        startedAt: '2026-01-01T00:00:00.000Z',
        entryPath: '/srv/foundry/backend.js',
      },
      FAKE_LOCK,
      {
        checkProcessName: () => true,
        readCommandLine: () => null,
      }
    );
    expect(result).toBe('valid');
  });

  it('requires a Node-named process for a legacy PID-only lock', () => {
    const readCommandLine = vi.fn();
    const result = evaluateLockFile(26188, FAKE_LOCK, {
      checkProcessName: () => false,
      readCommandLine,
    });
    expect(result).toBe('orphaned');
    expect(readCommandLine).not.toHaveBeenCalled();
  });
});

describe('parseBackendLockIdentity', () => {
  it('parses current JSON identity metadata', () => {
    expect(
      parseBackendLockIdentity(
        JSON.stringify({
          pid: 42,
          instanceId: 'abc',
          startedAt: '2026-01-01T00:00:00.000Z',
          entryPath: 'C:\\app\\backend.js',
        })
      )
    ).toEqual({
      pid: 42,
      instanceId: 'abc',
      startedAt: '2026-01-01T00:00:00.000Z',
      entryPath: 'C:\\app\\backend.js',
    });
  });

  it('parses legacy PID-only locks without using file age as identity', () => {
    expect(parseBackendLockIdentity('12345\n')).toEqual({
      pid: 12345,
      instanceId: 'legacy-12345',
      startedAt: '',
      entryPath: '',
    });
  });

  it('rejects corrupt or incomplete identities', () => {
    expect(parseBackendLockIdentity('')).toBeNull();
    expect(parseBackendLockIdentity('{')).toBeNull();
    expect(parseBackendLockIdentity('{"pid":42}')).toBeNull();
    expect(parseBackendLockIdentity('-1')).toBeNull();
  });
});

describe('acquireBackendLockFile', () => {
  it('waits for a simultaneous creator to finish writing an empty recent lock', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-lock-race-'));
    const lockFile = path.join(directory, 'backend.lock');
    const holder = {
      pid: 101,
      instanceId: 'holder-instance',
      startedAt: '2026-01-01T00:00:00.000Z',
      entryPath: '/app/backend.js',
    };
    const contender = {
      pid: 202,
      instanceId: 'contender-instance',
      startedAt: '2026-01-01T00:00:01.000Z',
      entryPath: '/app/backend.js',
    };
    fs.writeFileSync(lockFile, '');
    let waits = 0;

    try {
      const result = await acquireBackendLockFile(lockFile, contender, {
        initializationGraceMs: 100,
        retryDelayMs: 1,
        isProcessAlive: () => true,
        evaluateIdentity: () => 'valid',
        wait: async () => {
          waits += 1;
          fs.writeFileSync(lockFile, JSON.stringify(holder));
        },
      });

      expect(result).toEqual({ acquired: false, existing: holder });
      expect(waits).toBe(1);
      expect(parseBackendLockIdentity(fs.readFileSync(lockFile, 'utf8'))).toEqual(holder);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('replaces an old corrupt lock and writes a complete identity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-lock-corrupt-'));
    const lockFile = path.join(directory, 'backend.lock');
    const identity = {
      pid: 303,
      instanceId: 'replacement-instance',
      startedAt: '2026-01-01T00:00:02.000Z',
      entryPath: '/app/backend.js',
    };
    fs.writeFileSync(lockFile, '{');
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockFile, old, old);

    try {
      const result = await acquireBackendLockFile(lockFile, identity, {
        initializationGraceMs: 100,
      });
      expect(result.acquired).toBe(true);
      if (result.acquired) fs.closeSync(result.fd);
      expect(parseBackendLockIdentity(fs.readFileSync(lockFile, 'utf8'))).toEqual(identity);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
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
