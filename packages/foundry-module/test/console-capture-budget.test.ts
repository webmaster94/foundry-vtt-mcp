import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserConsoleCapture } from '../src/console-capture.js';

interface CaptureInternals {
  active: boolean;
  options: {
    enabled: boolean;
    maxEntries: number;
    maxEntryBytes: number;
    includeDebug: boolean;
    includeTrace: boolean;
  };
  capture: (level: string, args: unknown[], source: string) => void;
}

class MockNode {
  constructor(public nodeName: string) {}
}

class MockElement extends MockNode {
  constructor(
    public tagName: string,
    public id = '',
    public className = ''
  ) {
    super(tagName);
  }
}

class MockEvent {
  constructor(
    public type: string,
    public target: MockNode | null = null
  ) {}
}

const SETTINGS: Record<string, unknown> = {
  enableConsoleCapture: true,
  consoleCaptureMaxEntries: 1000,
  consoleCaptureMaxEntryBytes: 8192,
  consoleCaptureIncludeDebug: true,
  consoleCaptureIncludeTrace: true,
};

function createActiveCapture(): BrowserConsoleCapture {
  const capture = new BrowserConsoleCapture();
  const internals = capture as unknown as CaptureInternals;
  internals.active = true;
  internals.options = {
    enabled: true,
    maxEntries: 1000,
    maxEntryBytes: 8192,
    includeDebug: true,
    includeTrace: true,
  };
  return capture;
}

function captureLog(capture: BrowserConsoleCapture, args: unknown[]): void {
  (capture as unknown as CaptureInternals).capture('log', args, 'console');
}

function makeLazyTree(width: number, depth: number, onRead: () => void): Record<string, unknown> {
  if (depth === 0) {
    return { value: 'leaf' };
  }

  const value: Record<string, unknown> = {};
  for (let index = 0; index < width; index++) {
    Object.defineProperty(value, `key${index}`, {
      enumerable: true,
      get() {
        onRead();
        return makeLazyTree(width, depth - 1, onRead);
      },
    });
  }
  return value;
}

describe('BrowserConsoleCapture serialization budget', () => {
  beforeEach(() => {
    vi.stubGlobal('Node', MockNode);
    vi.stubGlobal('Element', MockElement);
    vi.stubGlobal('Event', MockEvent);
    vi.stubGlobal('game', {
      user: { id: 'gm', name: 'GM', isGM: true },
      world: { id: 'test-world' },
      settings: {
        get: (_moduleId: string, key: string) => SETTINGS[key],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bounds traversal work before walking a broad object graph', () => {
    let propertyReads = 0;
    const broadValue = makeLazyTree(15, 5, () => propertyReads++);
    const capture = createActiveCapture();

    captureLog(capture, [broadValue]);

    const [entry] = capture.getEntries({ includeRawArgs: true, limit: 1 }).entries;
    expect(entry).toBeDefined();
    expect(entry.truncated).toBe(true);
    expect(propertyReads).toBeLessThanOrEqual(512);
    expect(entry.text).toMatch(/Capture serialization budget exceeded|MaxDepth/);
    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(8192);
  });

  it('retains useful Error, Foundry Document, DOM, and circular summaries', () => {
    const capture = createActiveCapture();
    const document = {
      documentName: 'Actor',
      id: 'actor-1',
      uuid: 'Actor.actor-1',
      name: 'Test Actor',
      system: { deliberately: 'not copied' },
    };
    const element = new MockElement('BUTTON', 'roll-button', 'mcp-roll-button');
    const circular: Record<string, unknown> = { label: 'root' };
    circular.self = circular;

    captureLog(capture, [new Error('boom'), document, element, circular]);

    const [entry] = capture.getEntries({ includeRawArgs: true, limit: 1 }).entries;
    const args = entry.args as Array<Record<string, unknown>>;
    expect(args[0]).toMatchObject({ name: 'Error', message: 'boom' });
    expect(args[1]).toEqual({
      documentName: 'Actor',
      id: 'actor-1',
      uuid: 'Actor.actor-1',
      name: 'Test Actor',
    });
    expect(args[1]).not.toHaveProperty('system');
    expect(args[2]).toEqual({
      nodeType: 'Element',
      tagName: 'BUTTON',
      id: 'roll-button',
      className: 'mcp-roll-button',
    });
    expect(args[3]).toEqual({ label: 'root', self: '[Circular]' });
  });

  it('caps top-level arguments and array items across one capture', () => {
    const capture = createActiveCapture();
    const args: unknown[] = [Array.from({ length: 1000 }, (_, index) => index)];
    args.push(...Array.from({ length: 100 }, (_, index) => [`argument-${index}`]));

    captureLog(capture, args);

    const [entry] = capture.getEntries({ includeRawArgs: true, limit: 1 }).entries;
    const serializedArgs = entry.args as unknown[];
    expect(entry.truncated).toBe(true);
    expect(serializedArgs.length).toBeLessThanOrEqual(51);
    expect(serializedArgs[0]).toBeInstanceOf(Array);
    expect((serializedArgs[0] as unknown[]).length).toBeLessThanOrEqual(51);
    expect(entry.text).toContain('additional console arguments omitted');
  });

  it('enforces the configured limit as UTF-8 bytes at the 512-byte minimum', () => {
    const capture = createActiveCapture();
    const internals = capture as unknown as CaptureInternals;
    internals.options.maxEntryBytes = 512;

    internals.capture('warn', ['🧙'.repeat(1000)], 'console');

    const [entry] = capture.getEntries({ includeRawArgs: true, limit: 1 }).entries;
    expect(entry.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(entry)).byteLength).toBeLessThanOrEqual(512);
  });

  it('does not clobber console or notification wrappers installed after capture starts', () => {
    const originalLog = vi.fn();
    const originalInfo = vi.fn();
    const fakeConsole = { log: originalLog };
    const notifications = { info: originalInfo };
    const externalOnError = vi.fn();
    vi.stubGlobal('console', fakeConsole);
    vi.stubGlobal('ui', { notifications });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onerror: externalOnError,
    });

    const capture = new BrowserConsoleCapture();
    capture.start();
    const captureLogWrapper = fakeConsole.log;
    const captureInfoWrapper = notifications.info;
    const laterLogWrapper = vi.fn((...args: unknown[]) => captureLogWrapper(...args));
    const laterInfoWrapper = vi.fn((...args: unknown[]) => captureInfoWrapper(...args));
    fakeConsole.log = laterLogWrapper;
    notifications.info = laterInfoWrapper;

    capture.stop();

    expect(fakeConsole.log).toBe(laterLogWrapper);
    expect(notifications.info).toBe(laterInfoWrapper);
    expect((globalThis as any).window.onerror).toBe(externalOnError);

    capture.start();
    laterLogWrapper('single-console-entry');
    laterInfoWrapper('single-notification-entry');
    capture.stop();

    expect(capture.getEntries({ search: 'single-console-entry' }).entries).toHaveLength(1);
    expect(capture.getEntries({ search: 'single-notification-entry' }).entries).toHaveLength(1);
    expect((globalThis as any).window.onerror).toBe(externalOnError);
  });
});
