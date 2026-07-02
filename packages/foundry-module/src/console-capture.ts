import { MODULE_ID } from './constants.js';

export type BrowserConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace'
  | 'table'
  | 'dir'
  | 'dirxml'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'time'
  | 'timeLog'
  | 'timeEnd'
  | 'count'
  | 'countReset'
  | 'assert'
  | 'clear';

export type BrowserConsoleSource =
  | 'console'
  | 'window-error'
  | 'unhandled-rejection'
  | 'resource-error'
  | 'notification';

export interface BrowserConsoleEntry {
  id: number;
  timestamp: string;
  level: BrowserConsoleLevel;
  text: string;
  args?: unknown[];
  stack?: string;
  source: BrowserConsoleSource;
  url?: string;
  line?: number;
  column?: number;
  userId: string;
  userName: string;
  worldId: string;
  scriptExecutionId?: string;
  truncated: boolean;
}

export interface BrowserConsoleQuery {
  levels?: BrowserConsoleLevel[];
  sinceId?: number;
  sinceTimestamp?: string;
  limit?: number;
  search?: string;
  includeStack?: boolean;
  includeRawArgs?: boolean;
}

interface CaptureOptions {
  enabled: boolean;
  maxEntries: number;
  maxEntryBytes: number;
  includeDebug: boolean;
  includeTrace: boolean;
}

type ConsoleMethod = (...args: unknown[]) => void;
type NotificationMethod = (...args: unknown[]) => unknown;

const DEFAULT_OPTIONS: CaptureOptions = {
  enabled: true,
  maxEntries: 1000,
  maxEntryBytes: 8192,
  includeDebug: true,
  includeTrace: true,
};

const CONSOLE_METHODS: BrowserConsoleLevel[] = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'table',
  'dir',
  'dirxml',
  'group',
  'groupCollapsed',
  'groupEnd',
  'time',
  'timeLog',
  'timeEnd',
  'count',
  'countReset',
  'assert',
  'clear',
];

export class BrowserConsoleCapture {
  private active = false;
  private nextId = 1;
  private entries: BrowserConsoleEntry[] = [];
  private options: CaptureOptions = { ...DEFAULT_OPTIONS };
  private originalConsoleMethods = new Map<BrowserConsoleLevel, ConsoleMethod>();
  private originalNotificationMethods = new Map<'info' | 'warn' | 'error', NotificationMethod>();
  private currentScriptExecutionId: string | undefined;
  private resourceErrorHandler: ((event: ErrorEvent) => void) | undefined;
  private unhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | undefined;
  private windowErrorHandler: OnErrorEventHandler | undefined;
  private installedWindowErrorHandler: OnErrorEventHandler | undefined;
  private previousWindowErrorHandler: OnErrorEventHandler | null = null;

  configureFromSettings(): void {
    this.options = {
      enabled: this.readSetting('enableConsoleCapture', DEFAULT_OPTIONS.enabled),
      maxEntries: this.clampNumber(
        this.readSetting('consoleCaptureMaxEntries', DEFAULT_OPTIONS.maxEntries),
        1,
        10000,
        DEFAULT_OPTIONS.maxEntries
      ),
      maxEntryBytes: this.clampNumber(
        this.readSetting('consoleCaptureMaxEntryBytes', DEFAULT_OPTIONS.maxEntryBytes),
        512,
        65536,
        DEFAULT_OPTIONS.maxEntryBytes
      ),
      includeDebug: this.readSetting('consoleCaptureIncludeDebug', DEFAULT_OPTIONS.includeDebug),
      includeTrace: this.readSetting('consoleCaptureIncludeTrace', DEFAULT_OPTIONS.includeTrace),
    };

    this.trimBuffer();
  }

  start(): void {
    this.configureFromSettings();

    if (!this.options.enabled || this.active || !this.isGM()) {
      return;
    }

    this.active = true;
    this.patchConsole();
    this.patchNotifications();
    this.installWindowHandlers();
    this.capture('info', [`${MODULE_ID} browser console capture started`], 'console');
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    this.capture('info', [`${MODULE_ID} browser console capture stopped`], 'console');
    this.restoreConsole();
    this.restoreNotifications();
    this.removeWindowHandlers();
    this.active = false;
  }

  restart(): void {
    if (this.active) {
      this.stop();
    }
    this.start();
  }

  setScriptExecutionId(scriptExecutionId: string | undefined): void {
    this.currentScriptExecutionId = scriptExecutionId;
  }

  getEntries(query: BrowserConsoleQuery = {}): {
    entries: BrowserConsoleEntry[];
    totalStored: number;
    nextId: number;
    truncated: boolean;
  } {
    this.configureFromSettings();

    const limit = this.clampNumber(query.limit ?? 100, 1, 500, 100);
    const levelSet = query.levels?.length ? new Set(query.levels) : null;
    const sinceTime = query.sinceTimestamp ? Date.parse(query.sinceTimestamp) : undefined;
    const search = query.search?.toLocaleLowerCase();

    let filtered = this.entries.filter((entry) => {
      if (levelSet && !levelSet.has(entry.level)) return false;
      if (query.sinceId !== undefined && entry.id <= query.sinceId) return false;
      if (sinceTime !== undefined && Number.isFinite(sinceTime) && Date.parse(entry.timestamp) < sinceTime) return false;
      if (search && !entry.text.toLocaleLowerCase().includes(search)) return false;
      return true;
    });

    const truncated = filtered.length > limit;
    filtered = filtered.slice(-limit);

    return {
      entries: filtered.map((entry) => this.projectEntry(entry, query)),
      totalStored: this.entries.length,
      nextId: this.nextId,
      truncated,
    };
  }

  clear(confirmClear: boolean): { success: boolean; clearedCount: number; nextId: number } {
    if (!confirmClear) {
      throw new Error('clear-browser-console requires confirmClear=true');
    }

    const clearedCount = this.entries.length;
    this.entries = [];
    this.capture('clear', ['Browser console capture buffer cleared'], 'console');

    return {
      success: true,
      clearedCount,
      nextId: this.nextId,
    };
  }

  getStatus(): {
    enabled: boolean;
    active: boolean;
    totalStored: number;
    nextId: number;
    maxEntries: number;
    maxEntryBytes: number;
    includeDebug: boolean;
    includeTrace: boolean;
    gmOnly: boolean;
    userIsGM: boolean;
  } {
    this.configureFromSettings();

    return {
      enabled: this.options.enabled,
      active: this.active,
      totalStored: this.entries.length,
      nextId: this.nextId,
      maxEntries: this.options.maxEntries,
      maxEntryBytes: this.options.maxEntryBytes,
      includeDebug: this.options.includeDebug,
      includeTrace: this.options.includeTrace,
      gmOnly: true,
      userIsGM: this.isGM(),
    };
  }

  private patchConsole(): void {
    for (const method of CONSOLE_METHODS) {
      const original = (console as unknown as Record<string, ConsoleMethod>)[method];
      if (typeof original !== 'function' || this.originalConsoleMethods.has(method)) {
        continue;
      }

      this.originalConsoleMethods.set(method, original.bind(console));

      (console as unknown as Record<string, ConsoleMethod>)[method] = (...args: unknown[]) => {
        try {
          original.apply(console, args);
        } finally {
          this.captureConsoleCall(method, args);
        }
      };
    }
  }

  private restoreConsole(): void {
    for (const [method, original] of this.originalConsoleMethods.entries()) {
      (console as unknown as Record<string, ConsoleMethod>)[method] = original;
    }
    this.originalConsoleMethods.clear();
  }

  private patchNotifications(): void {
    const notifications = (globalThis as any).ui?.notifications;
    if (!notifications) {
      return;
    }

    for (const level of ['info', 'warn', 'error'] as const) {
      const original = notifications[level];
      if (typeof original !== 'function' || this.originalNotificationMethods.has(level)) {
        continue;
      }

      this.originalNotificationMethods.set(level, original.bind(notifications));
      notifications[level] = (...args: unknown[]) => {
        try {
          return original.apply(notifications, args);
        } finally {
          this.capture(level, args, 'notification');
        }
      };
    }
  }

  private restoreNotifications(): void {
    const notifications = (globalThis as any).ui?.notifications;
    if (!notifications) {
      this.originalNotificationMethods.clear();
      return;
    }

    for (const [level, original] of this.originalNotificationMethods.entries()) {
      notifications[level] = original;
    }
    this.originalNotificationMethods.clear();
  }

  private installWindowHandlers(): void {
    this.windowErrorHandler = (message, source, lineno, colno, error) => {
      const metadata: Partial<Pick<BrowserConsoleEntry, 'url' | 'line' | 'column' | 'stack'>> = {};
      if (typeof source === 'string') metadata.url = source;
      if (typeof lineno === 'number') metadata.line = lineno;
      if (typeof colno === 'number') metadata.column = colno;
      if (error instanceof Error && error.stack) metadata.stack = error.stack;

      this.capture('error', [error ?? message], 'window-error', metadata);
      return false;
    };

    this.resourceErrorHandler = (event: ErrorEvent) => {
      if (event.error || event.message) {
        return;
      }

      const target = event.target as HTMLElement | undefined;
      const url = this.getResourceUrl(target);
      const label = target?.tagName ? `${target.tagName} failed to load` : 'Resource failed to load';
      const metadata: Partial<Pick<BrowserConsoleEntry, 'url'>> = {};
      if (url) metadata.url = url;

      this.capture('error', [label, url].filter(Boolean), 'resource-error', metadata);
    };

    this.unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const metadata: Partial<Pick<BrowserConsoleEntry, 'stack'>> = {};
      if (event.reason instanceof Error && event.reason.stack) metadata.stack = event.reason.stack;

      this.capture('error', [event.reason ?? 'Unhandled promise rejection'], 'unhandled-rejection', metadata);
    };

    window.addEventListener('error', this.resourceErrorHandler, true);
    window.addEventListener('unhandledrejection', this.unhandledRejectionHandler);

    this.previousWindowErrorHandler = window.onerror;
    this.installedWindowErrorHandler = (...args) => {
      this.windowErrorHandler?.(...args);

      if (typeof this.previousWindowErrorHandler === 'function') {
        return this.previousWindowErrorHandler.apply(window, args);
      }

      return false;
    };
    window.onerror = this.installedWindowErrorHandler;
  }

  private removeWindowHandlers(): void {
    if (this.resourceErrorHandler) {
      window.removeEventListener('error', this.resourceErrorHandler, true);
      this.resourceErrorHandler = undefined;
    }

    if (this.unhandledRejectionHandler) {
      window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = undefined;
    }

    if (this.installedWindowErrorHandler && window.onerror === this.installedWindowErrorHandler) {
      window.onerror = this.previousWindowErrorHandler;
    }

    this.windowErrorHandler = undefined;
    this.installedWindowErrorHandler = undefined;
    this.previousWindowErrorHandler = null;
  }

  private captureConsoleCall(level: BrowserConsoleLevel, args: unknown[]): void {
    if (level === 'assert' && args[0]) {
      return;
    }

    const captureArgs = level === 'assert' ? args.slice(1) : args;
    this.capture(level, captureArgs.length ? captureArgs : [`console.${level}`], 'console');
  }

  private capture(
    level: BrowserConsoleLevel,
    args: unknown[],
    source: BrowserConsoleSource,
    metadata: Partial<Pick<BrowserConsoleEntry, 'url' | 'line' | 'column' | 'stack'>> = {}
  ): void {
    if (!this.active || !this.options.enabled || !this.isGM()) {
      return;
    }

    if (level === 'debug' && !this.options.includeDebug) {
      return;
    }

    if (level === 'trace' && !this.options.includeTrace) {
      return;
    }

    try {
      const serializedArgs = args.map((arg) => this.serializeValue(arg, new WeakSet<object>()));
      let text = serializedArgs.map((arg) => this.formatText(arg)).join(' ');
      let truncated = false;
      let stack = metadata.stack;

      if (!stack && (level === 'error' || level === 'warn' || level === 'trace')) {
        stack = new Error().stack;
      }

      let entry: BrowserConsoleEntry = {
        id: this.nextId++,
        timestamp: new Date().toISOString(),
        level,
        text,
        args: serializedArgs,
        source,
        userId: (globalThis as any).game?.user?.id ?? 'unknown',
        userName: (globalThis as any).game?.user?.name ?? 'Unknown',
        worldId: (globalThis as any).game?.world?.id ?? 'unknown',
        truncated,
      };

      if (metadata.url) entry.url = metadata.url;
      if (metadata.line !== undefined) entry.line = metadata.line;
      if (metadata.column !== undefined) entry.column = metadata.column;
      if (stack) entry.stack = stack;
      if (this.currentScriptExecutionId) entry.scriptExecutionId = this.currentScriptExecutionId;

      const limited = this.enforceEntryLimit(entry);
      entry = limited.entry;
      text = entry.text;
      truncated = limited.truncated;
      entry.text = text;
      entry.truncated = truncated;

      this.entries.push(entry);
      this.trimBuffer();
    } catch {
      // Console capture must never interfere with the browser console.
    }
  }

  private enforceEntryLimit(entry: BrowserConsoleEntry): { entry: BrowserConsoleEntry; truncated: boolean } {
    let serialized = JSON.stringify(entry);
    if (serialized.length <= this.options.maxEntryBytes) {
      return { entry, truncated: entry.truncated };
    }

    const budget = Math.max(128, this.options.maxEntryBytes - 512);
    entry.text = this.truncateString(entry.text, budget);
    entry.args = [{ summary: 'Arguments omitted because the console entry exceeded the configured size limit.' }];
    if (entry.stack) {
      entry.stack = this.truncateString(entry.stack, 2048);
    } else {
      delete entry.stack;
    }
    entry.truncated = true;

    serialized = JSON.stringify(entry);
    if (serialized.length > this.options.maxEntryBytes) {
      entry.text = this.truncateString(entry.text, Math.max(64, budget - (serialized.length - this.options.maxEntryBytes)));
    }

    return { entry, truncated: true };
  }

  private projectEntry(entry: BrowserConsoleEntry, query: BrowserConsoleQuery): BrowserConsoleEntry {
    const projected: BrowserConsoleEntry = { ...entry };

    if (!query.includeRawArgs) {
      delete projected.args;
    }

    if (query.includeStack === false) {
      delete projected.stack;
    }

    return projected;
  }

  private serializeValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    const valueType = typeof value;
    if (valueType === 'string') return this.truncateString(value as string, this.options.maxEntryBytes);
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') return String(value);
    if (valueType === 'symbol') return String(value);
    if (valueType === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;

    if (depth > 4) {
      return '[MaxDepth]';
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (value instanceof Promise) {
      return '[Promise]';
    }

    if (value instanceof Event) {
      return {
        eventType: value.type,
        target: this.serializeDomNode(value.target),
      };
    }

    if (value instanceof Node) {
      return this.serializeDomNode(value);
    }

    if (valueType === 'object') {
      const objectValue = value as Record<string, unknown>;

      if (seen.has(objectValue)) {
        return '[Circular]';
      }
      seen.add(objectValue);

      const documentSummary = this.serializeFoundryDocument(objectValue);
      if (documentSummary) {
        return documentSummary;
      }

      if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => this.serializeValue(item, seen, depth + 1));
      }

      const output: Record<string, unknown> = {};
      for (const key of Object.keys(objectValue).slice(0, 50)) {
        output[key] = this.serializeValue(objectValue[key], seen, depth + 1);
      }
      return output;
    }

    return String(value);
  }

  private serializeFoundryDocument(value: Record<string, unknown>): Record<string, unknown> | null {
    const documentName = typeof value.documentName === 'string' ? value.documentName : undefined;
    const id = typeof value.id === 'string' ? value.id : undefined;
    const uuid = typeof value.uuid === 'string' ? value.uuid : undefined;
    const name = typeof value.name === 'string' ? value.name : undefined;

    if (!documentName && !uuid) {
      return null;
    }

    return {
      documentName,
      id,
      uuid,
      name,
    };
  }

  private serializeDomNode(value: EventTarget | Node | null): unknown {
    if (!value || !(value instanceof Node)) {
      return null;
    }

    if (value instanceof Element) {
      return {
        nodeType: 'Element',
        tagName: value.tagName,
        id: value.id || undefined,
        className: typeof value.className === 'string' ? value.className : undefined,
      };
    }

    return {
      nodeType: value.nodeName,
    };
  }

  private formatText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private trimBuffer(): void {
    const overflow = this.entries.length - this.options.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }
  }

  private readSetting<T>(key: string, fallback: T): T {
    try {
      return (game.settings.get(MODULE_ID, key) as T) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, numberValue));
  }

  private truncateString(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 15))}... [truncated]`;
  }

  private getResourceUrl(target: HTMLElement | undefined): string | undefined {
    if (!target) {
      return undefined;
    }

    const withSrc = target as HTMLElement & { src?: string; href?: string };
    return withSrc.src || withSrc.href || undefined;
  }

  private isGM(): boolean {
    return (globalThis as any).game?.user?.isGM === true;
  }
}

export const browserConsoleCapture = new BrowserConsoleCapture();
