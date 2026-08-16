import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { ConfigSnapshot, SaveConfigResult } from '../shared/contracts.js';
import { ConfigValidator } from './config-validation.js';

export type TypedConfigSnapshot<T> = Omit<ConfigSnapshot, 'value'> & { value: T };
export type TypedSaveConfigResult<T> = Omit<SaveConfigResult, 'value'> & { value: T };

export interface ConfigApplyHooks<T> {
  apply(value: T): Promise<void>;
  rollback(previousValue: T | null): Promise<void>;
}

export interface SaveConfigOptions<T> {
  expectedHash: string | null;
  hooks?: ConfigApplyHooks<T>;
  allowInvalidPrevious?: boolean;
}

export interface ConfigStoreOptions {
  /** Optional coordination hook used by callers that need to delay a commit. */
  beforeSaveCommit?(): Promise<void>;
}

export type ConfigInspection<T> =
  | (TypedConfigSnapshot<T> & { valid: true })
  | {
      path: string;
      exists: true;
      hash: string;
      valid: false;
      error: string;
    };

export class ConfigConflictError extends Error {
  constructor(expected: string | null, actual: string | null) {
    super(
      `Configuration changed on disk (expected ${expected ?? 'no file'}, found ${actual ?? 'no file'})`
    );
    this.name = 'ConfigConflictError';
  }
}

export class ConfigApplyError extends Error {
  constructor(
    message: string,
    public readonly applyError: unknown,
    public readonly rollbackError?: unknown
  ) {
    super(message);
    this.name = 'ConfigApplyError';
  }
}

function hash(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to read non-regular configuration file: ${filePath}`);
    }
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory configuration path: ${directory}`);
  }
}

async function writeAtomic(
  filePath: string,
  contents: Buffer,
  beforeCommit?: () => Promise<void>
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureSafeDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await beforeCommit?.();
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertCurrentHash(filePath: string, expectedHash: string | null): Promise<void> {
  const currentContents = await readOptional(filePath);
  const currentHash = currentContents ? hash(currentContents) : null;
  if (currentHash !== expectedHash) throw new ConfigConflictError(expectedHash, currentHash);
}

export class ConfigStore<T extends object> {
  public readonly backupPath: string;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(
    public readonly filePath: string,
    private readonly validate: ConfigValidator<T>,
    private readonly defaultValue: () => T,
    private readonly options: ConfigStoreOptions = {}
  ) {
    this.filePath = path.resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
  }

  async ensure(): Promise<TypedConfigSnapshot<T>> {
    const current = await readOptional(this.filePath);
    if (current) return this.snapshotFromBytes(current);
    const value = this.validate(this.defaultValue());
    const contents = serialize(value);
    await writeAtomic(this.filePath, contents);
    return {
      path: this.filePath,
      exists: true,
      hash: hash(contents),
      value,
    };
  }

  async read(): Promise<TypedConfigSnapshot<T>> {
    const contents = await readOptional(this.filePath);
    if (!contents) {
      return {
        path: this.filePath,
        exists: false,
        hash: null,
        value: this.validate(this.defaultValue()),
      };
    }
    return this.snapshotFromBytes(contents);
  }

  async inspect(): Promise<ConfigInspection<T>> {
    const contents = await readOptional(this.filePath);
    if (!contents) {
      return {
        path: this.filePath,
        exists: false,
        hash: null,
        value: this.validate(this.defaultValue()),
        valid: true,
      };
    }
    try {
      return { ...this.snapshotFromBytes(contents), valid: true };
    } catch (error) {
      return {
        path: this.filePath,
        exists: true,
        hash: hash(contents),
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async save(value: unknown, options: SaveConfigOptions<T>): Promise<TypedSaveConfigResult<T>> {
    const operation = this.saveTail.then(() => this.saveInternal(value, options));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async saveInternal(
    value: unknown,
    options: SaveConfigOptions<T>
  ): Promise<TypedSaveConfigResult<T>> {
    const validated = this.validate(value);
    const nextContents = serialize(validated);
    const previousContents = await readOptional(this.filePath);
    const previousHash = previousContents ? hash(previousContents) : null;
    if (previousHash !== options.expectedHash) {
      throw new ConfigConflictError(options.expectedHash, previousHash);
    }

    const nextHash = hash(nextContents);
    if (nextHash === previousHash) {
      return {
        path: this.filePath,
        exists: true,
        hash: nextHash,
        previousHash,
        value: validated,
        changed: false,
        backupPath: null,
      };
    }

    let previousValue: T | null = null;
    if (previousContents) {
      try {
        previousValue = this.parse(previousContents);
      } catch (error) {
        if (!options.allowInvalidPrevious) throw error;
      }
      await writeAtomic(this.backupPath, previousContents);
    }
    await writeAtomic(this.filePath, nextContents, async () => {
      await this.options.beforeSaveCommit?.();
      await assertCurrentHash(this.filePath, previousHash);
    });

    try {
      await options.hooks?.apply(validated);
    } catch (applyError) {
      let rollbackError: unknown;
      try {
        if (previousContents) {
          await writeAtomic(this.filePath, previousContents, () =>
            assertCurrentHash(this.filePath, nextHash)
          );
        } else {
          await assertCurrentHash(this.filePath, nextHash);
          await fs.rm(this.filePath, { force: true });
        }
        await options.hooks?.rollback(previousValue);
      } catch (error) {
        rollbackError = error;
      }
      const suffix = rollbackError ? '; rollback also failed' : '; the prior file was restored';
      throw new ConfigApplyError(
        `The backend rejected the new server configuration${suffix}`,
        applyError,
        rollbackError
      );
    }

    return {
      path: this.filePath,
      exists: true,
      hash: nextHash,
      previousHash,
      value: validated,
      changed: true,
      backupPath: previousContents ? this.backupPath : null,
    };
  }

  private snapshotFromBytes(contents: Buffer): TypedConfigSnapshot<T> {
    return {
      path: this.filePath,
      exists: true,
      hash: hash(contents),
      value: this.parse(contents),
    };
  }

  private parse(contents: Buffer): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString('utf8'));
    } catch (error) {
      throw new Error(
        `Server configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return this.validate(parsed);
  }
}
