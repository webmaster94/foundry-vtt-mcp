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

interface SerializationBudget {
  remainingNodes: number;
  remainingProperties: number;
  remainingArrayItems: number;
  remainingStringCharacters: number;
  truncated: boolean;
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

const SERIALIZATION_LIMITS = {
  maxArguments: 50,
  maxNodes: 512,
  maxProperties: 512,
  maxArrayItems: 256,
  maxPropertiesPerObject: 50,
  maxItemsPerArray: 50,
  maxPropertyKeyCharacters: 128,
  maxDepth: 4,
} as const;

const SERIALIZATION_BUDGET_EXCEEDED = '[Capture serialization budget exceeded]';
const SERIALIZATION_TRUNCATION_KEY = '__mcpCaptureTruncated';
const UTF8_ENCODER = new TextEncoder();

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
  private installedConsoleMethods = new Map<BrowserConsoleLevel, ConsoleMethod>();
  private originalNotificationMethods = new Map<'info' | 'warn' | 'error', NotificationMethod>();
  private installedNotificationMethods = new Map<'info' | 'warn' | 'error', NotificationMethod>();
  private currentScriptExecutionId: string | undefined;
  private resourceErrorHandler: ((event: ErrorEvent) => void) | undefined;
  private unhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | undefined;

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

    let filtered = this.entries.filter(entry => {
      if (levelSet && !levelSet.has(entry.level)) return false;
      if (query.sinceId !== undefined && entry.id <= query.sinceId) return false;
      if (
        sinceTime !== undefined &&
        Number.isFinite(sinceTime) &&
        Date.parse(entry.timestamp) < sinceTime
      )
        return false;
      if (search && !entry.text.toLocaleLowerCase().includes(search)) return false;
      return true;
    });

    const truncated = filtered.length > limit;
    filtered = filtered.slice(-limit);

    return {
      entries: filtered.map(entry => this.projectEntry(entry, query)),
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
      if (typeof original !== 'function') continue;

      if (this.originalConsoleMethods.has(method)) {
        // If a later wrapper still owns the method, it normally chains through
        // our installed wrapper. Reuse that wrapper instead of adding a layer on
        // every idle wake. If another module restored the true original, rebuild.
        if (original !== this.originalConsoleMethods.get(method)) continue;
        this.originalConsoleMethods.delete(method);
        this.installedConsoleMethods.delete(method);
      }

      this.originalConsoleMethods.set(method, original);
      const wrapper: ConsoleMethod = (...args: unknown[]) => {
        try {
          original.apply(console, args);
        } finally {
          this.captureConsoleCall(method, args);
        }
      };
      this.installedConsoleMethods.set(method, wrapper);
      (console as unknown as Record<string, ConsoleMethod>)[method] = wrapper;
    }
  }

  private restoreConsole(): void {
    for (const [method, original] of this.originalConsoleMethods.entries()) {
      const methods = console as unknown as Record<string, ConsoleMethod>;
      if (methods[method] === this.installedConsoleMethods.get(method)) {
        methods[method] = original;
        this.originalConsoleMethods.delete(method);
        this.installedConsoleMethods.delete(method);
      }
    }
  }

  private patchNotifications(): void {
    const notifications = (globalThis as any).ui?.notifications;
    if (!notifications) {
      return;
    }

    for (const level of ['info', 'warn', 'error'] as const) {
      const original = notifications[level];
      if (typeof original !== 'function') continue;

      if (this.originalNotificationMethods.has(level)) {
        if (original !== this.originalNotificationMethods.get(level)) continue;
        this.originalNotificationMethods.delete(level);
        this.installedNotificationMethods.delete(level);
      }

      this.originalNotificationMethods.set(level, original);
      const wrapper: NotificationMethod = (...args: unknown[]) => {
        try {
          return original.apply(notifications, args);
        } finally {
          this.capture(level, args, 'notification');
        }
      };
      this.installedNotificationMethods.set(level, wrapper);
      notifications[level] = wrapper;
    }
  }

  private restoreNotifications(): void {
    const notifications = (globalThis as any).ui?.notifications;
    if (!notifications) {
      this.originalNotificationMethods.clear();
      this.installedNotificationMethods.clear();
      return;
    }

    for (const [level, original] of this.originalNotificationMethods.entries()) {
      if (notifications[level] === this.installedNotificationMethods.get(level)) {
        notifications[level] = original;
        this.originalNotificationMethods.delete(level);
        this.installedNotificationMethods.delete(level);
      }
    }
  }

  private installWindowHandlers(): void {
    this.resourceErrorHandler = (event: ErrorEvent) => {
      if (event.error || event.message) {
        const metadata: Partial<Pick<BrowserConsoleEntry, 'url' | 'line' | 'column' | 'stack'>> =
          {};
        if (event.filename) metadata.url = event.filename;
        if (typeof event.lineno === 'number') metadata.line = event.lineno;
        if (typeof event.colno === 'number') metadata.column = event.colno;
        if (event.error instanceof Error && event.error.stack) metadata.stack = event.error.stack;
        this.capture('error', [event.error ?? event.message], 'window-error', metadata);
        return;
      }

      const target = event.target as HTMLElement | undefined;
      const url = this.getResourceUrl(target);
      const label = target?.tagName
        ? `${target.tagName} failed to load`
        : 'Resource failed to load';
      const metadata: Partial<Pick<BrowserConsoleEntry, 'url'>> = {};
      if (url) metadata.url = url;

      this.capture('error', [label, url].filter(Boolean), 'resource-error', metadata);
    };

    this.unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const metadata: Partial<Pick<BrowserConsoleEntry, 'stack'>> = {};
      if (event.reason instanceof Error && event.reason.stack) metadata.stack = event.reason.stack;

      this.capture(
        'error',
        [event.reason ?? 'Unhandled promise rejection'],
        'unhandled-rejection',
        metadata
      );
    };

    window.addEventListener('error', this.resourceErrorHandler, true);
    window.addEventListener('unhandledrejection', this.unhandledRejectionHandler);
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
      const serializationBudget = this.createSerializationBudget();
      const serializedArgs: unknown[] = [];
      const argumentLimit = Math.min(args.length, SERIALIZATION_LIMITS.maxArguments);

      for (let index = 0; index < argumentLimit; index++) {
        if (serializationBudget.remainingNodes <= 0) {
          serializationBudget.truncated = true;
          serializedArgs.push(SERIALIZATION_BUDGET_EXCEEDED);
          break;
        }

        serializedArgs.push(
          this.serializeValue(args[index], new WeakSet<object>(), serializationBudget)
        );
      }

      if (args.length > argumentLimit) {
        serializationBudget.truncated = true;
        serializedArgs.push(
          `[${args.length - argumentLimit} additional console arguments omitted]`
        );
      }

      let text = serializedArgs.map(arg => this.formatText(arg)).join(' ');
      let truncated = serializationBudget.truncated;
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

  private enforceEntryLimit(entry: BrowserConsoleEntry): {
    entry: BrowserConsoleEntry;
    truncated: boolean;
  } {
    const maxBytes = this.options.maxEntryBytes;
    if (this.getSerializedByteLength(entry) <= maxBytes) {
      return { entry, truncated: entry.truncated };
    }

    entry.truncated = true;
    entry.args = [
      {
        summary: 'Arguments omitted because the console entry exceeded the configured size limit.',
      },
    ];
    if (entry.stack) {
      entry.stack = this.truncateUtf8(entry.stack, Math.min(2048, Math.floor(maxBytes / 3)));
    }
    entry.text = this.truncateUtf8(entry.text, Math.max(32, Math.floor(maxBytes / 2)));

    if (this.getSerializedByteLength(entry) <= maxBytes) return { entry, truncated: true };
    delete entry.args;
    if (this.getSerializedByteLength(entry) <= maxBytes) return { entry, truncated: true };
    delete entry.stack;
    if (this.getSerializedByteLength(entry) <= maxBytes) return { entry, truncated: true };

    // Optional diagnostic metadata is less important than a readable message.
    delete entry.url;
    delete entry.line;
    delete entry.column;
    delete entry.scriptExecutionId;
    entry.userId = this.truncateUtf8(entry.userId, 64);
    entry.userName = this.truncateUtf8(entry.userName, 64);
    entry.worldId = this.truncateUtf8(entry.worldId, 64);
    this.fitEntryTextToByteLimit(entry, maxBytes);

    if (this.getSerializedByteLength(entry) > maxBytes) {
      const minimalEntry: BrowserConsoleEntry = {
        id: entry.id,
        timestamp: entry.timestamp,
        level: entry.level,
        text: '[Console entry omitted: size limit]',
        source: entry.source,
        userId: '',
        userName: '',
        worldId: '',
        truncated: true,
      };
      this.fitEntryTextToByteLimit(minimalEntry, maxBytes);
      entry = minimalEntry;
    }

    return { entry, truncated: true };
  }

  private getSerializedByteLength(value: unknown): number {
    return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
  }

  private truncateUtf8(value: string, maxBytes: number): string {
    if (UTF8_ENCODER.encode(value).byteLength <= maxBytes) return value;

    let low = 0;
    let high = value.length;
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = value.slice(0, middle);
      if (UTF8_ENCODER.encode(candidate).byteLength <= maxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  private fitEntryTextToByteLimit(entry: BrowserConsoleEntry, maxBytes: number): void {
    const originalText = entry.text;
    let low = 0;
    let high = originalText.length;
    let best = '';

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      entry.text = originalText.slice(0, middle);
      if (this.getSerializedByteLength(entry) <= maxBytes) {
        best = entry.text;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    entry.text = best;
  }

  private projectEntry(
    entry: BrowserConsoleEntry,
    query: BrowserConsoleQuery
  ): BrowserConsoleEntry {
    const projected: BrowserConsoleEntry = { ...entry };

    if (!query.includeRawArgs) {
      delete projected.args;
    }

    if (query.includeStack === false) {
      delete projected.stack;
    }

    return projected;
  }

  private createSerializationBudget(): SerializationBudget {
    return {
      remainingNodes: SERIALIZATION_LIMITS.maxNodes,
      remainingProperties: SERIALIZATION_LIMITS.maxProperties,
      remainingArrayItems: SERIALIZATION_LIMITS.maxArrayItems,
      remainingStringCharacters: this.options.maxEntryBytes,
      truncated: false,
    };
  }

  private serializeValue(
    value: unknown,
    seen: WeakSet<object>,
    budget: SerializationBudget,
    depth = 0
  ): unknown {
    if (depth > SERIALIZATION_LIMITS.maxDepth) {
      budget.truncated = true;
      return '[MaxDepth]';
    }

    if (budget.remainingNodes <= 0) {
      budget.truncated = true;
      return SERIALIZATION_BUDGET_EXCEEDED;
    }
    budget.remainingNodes--;

    if (value === null || value === undefined) {
      return value;
    }

    const valueType = typeof value;
    if (valueType === 'string') return this.serializeString(value as string, budget);
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
      return this.serializeString(String(value), budget);
    }
    if (valueType === 'symbol') return this.serializeString(String(value), budget);
    if (valueType === 'function') {
      const functionName = (value as { name?: string }).name ?? 'anonymous';
      return this.serializeString(`[Function ${functionName}]`, budget);
    }

    if (value instanceof Error) {
      return {
        name: this.serializeString(value.name, budget),
        message: this.serializeString(value.message, budget),
        stack: value.stack ? this.serializeString(value.stack, budget) : undefined,
      };
    }

    if (value instanceof Promise) {
      return '[Promise]';
    }

    if (value instanceof Event) {
      return {
        eventType: this.serializeString(value.type, budget),
        target: this.serializeDomNode(value.target, budget),
      };
    }

    if (value instanceof Node) {
      return this.serializeDomNode(value, budget);
    }

    if (valueType === 'object') {
      const objectValue = value as Record<string, unknown>;

      if (seen.has(objectValue)) {
        return '[Circular]';
      }
      seen.add(objectValue);

      const documentSummary = this.serializeFoundryDocument(objectValue, budget);
      if (documentSummary) {
        return documentSummary;
      }

      if (Array.isArray(value)) {
        const output: unknown[] = [];
        const itemLimit = Math.min(value.length, SERIALIZATION_LIMITS.maxItemsPerArray);
        let serializedItems = 0;

        for (let index = 0; index < itemLimit; index++) {
          if (budget.remainingArrayItems <= 0 || budget.remainingNodes <= 0) {
            break;
          }

          budget.remainingArrayItems--;
          serializedItems++;

          try {
            output.push(this.serializeValue(value[index], seen, budget, depth + 1));
          } catch {
            budget.truncated = true;
            output.push('[Array item could not be read]');
          }
        }

        if (serializedItems < value.length) {
          budget.truncated = true;
          output.push(`[${value.length - serializedItems} array items omitted]`);
        }

        return output;
      }

      const output: Record<string, unknown> = {};
      let serializedProperties = 0;
      let omittedProperties = false;

      for (const key in objectValue) {
        if (!Object.prototype.hasOwnProperty.call(objectValue, key)) {
          continue;
        }

        if (
          serializedProperties >= SERIALIZATION_LIMITS.maxPropertiesPerObject ||
          budget.remainingProperties <= 0 ||
          budget.remainingNodes <= 0
        ) {
          omittedProperties = true;
          break;
        }

        budget.remainingProperties--;
        serializedProperties++;

        const outputKey = this.serializePropertyKey(key, budget);
        try {
          output[outputKey] = this.serializeValue(objectValue[key], seen, budget, depth + 1);
        } catch {
          budget.truncated = true;
          output[outputKey] = '[Property could not be read]';
        }
      }

      if (omittedProperties) {
        budget.truncated = true;
        output[SERIALIZATION_TRUNCATION_KEY] = SERIALIZATION_BUDGET_EXCEEDED;
      }

      return output;
    }

    return this.serializeString(String(value), budget);
  }

  private serializeFoundryDocument(
    value: Record<string, unknown>,
    budget: SerializationBudget
  ): Record<string, unknown> | null {
    let documentName: string | undefined;
    let id: string | undefined;
    let uuid: string | undefined;
    let name: string | undefined;

    try {
      documentName = typeof value.documentName === 'string' ? value.documentName : undefined;
      id = typeof value.id === 'string' ? value.id : undefined;
      uuid = typeof value.uuid === 'string' ? value.uuid : undefined;
      name = typeof value.name === 'string' ? value.name : undefined;
    } catch {
      return null;
    }

    if (!documentName && !uuid) {
      return null;
    }

    return {
      documentName: documentName ? this.serializeString(documentName, budget) : undefined,
      id: id ? this.serializeString(id, budget) : undefined,
      uuid: uuid ? this.serializeString(uuid, budget) : undefined,
      name: name ? this.serializeString(name, budget) : undefined,
    };
  }

  private serializeDomNode(value: EventTarget | Node | null, budget: SerializationBudget): unknown {
    if (!value || !(value instanceof Node)) {
      return null;
    }

    if (value instanceof Element) {
      return {
        nodeType: 'Element',
        tagName: this.serializeString(value.tagName, budget),
        id: value.id ? this.serializeString(value.id, budget) : undefined,
        className:
          typeof value.className === 'string'
            ? this.serializeString(value.className, budget)
            : undefined,
      };
    }

    return {
      nodeType: this.serializeString(value.nodeName, budget),
    };
  }

  private serializeString(value: string, budget: SerializationBudget): string {
    const available = Math.max(0, budget.remainingStringCharacters);
    if (available === 0) {
      budget.truncated = true;
      return '';
    }

    if (value.length <= available) {
      budget.remainingStringCharacters -= value.length;
      return value;
    }

    budget.truncated = true;
    const suffix = '... [truncated]';
    const serialized =
      available <= suffix.length
        ? value.slice(0, available)
        : `${value.slice(0, available - suffix.length)}${suffix}`;
    budget.remainingStringCharacters -= serialized.length;
    return serialized;
  }

  private serializePropertyKey(key: string, budget: SerializationBudget): string {
    if (key.length <= SERIALIZATION_LIMITS.maxPropertyKeyCharacters) {
      return key;
    }

    budget.truncated = true;
    return this.truncateString(key, SERIALIZATION_LIMITS.maxPropertyKeyCharacters);
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
