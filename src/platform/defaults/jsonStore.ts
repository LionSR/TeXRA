import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';

import type { StateStore } from '../interfaces';

const CHANNEL = 'JsonStore';
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_OPTIONS = {
  retries: 120,
  factor: 1.2,
  minTimeout: 10,
  maxTimeout: 100,
} as const;

type JsonRecord = Record<string, unknown>;

export interface JsonStoreOptions {
  /**
   * POSIX mode for the store file (e.g. `0o600` to restrict a secrets file
   * to its owner). The containing directory is created/chmod'd with the
   * same owner permissions plus execute — `0o600` -> `0o700` — so it stays
   * traversable. Left unset, `mkdir`/`writeFileAtomic` use their platform
   * defaults, matching prior `JsonStore` behavior.
   */
  mode?: number;
  /**
   * When true, malformed JSON is a hard failure (rethrown) instead of being
   * silently treated as an empty store. Callers that overwrite the whole
   * file on every write (read-mutate-write, e.g. `CliSecrets`) need this:
   * defaulting a transient parse failure to `{}` would permanently wipe
   * every other stored value on the very next write. Defaults to false,
   * preserving the self-healing behavior existing state/config stores rely
   * on.
   */
  strict?: boolean;
}

/** `0o600` -> `0o700`: adds owner-execute wherever owner-read is set. */
function dirModeFor(fileMode: number): number {
  return fileMode | ((fileMode & 0o444) >> 2);
}

async function readJsonRecord(
  filePath: string,
  strict: boolean,
  fallback: JsonRecord = {},
): Promise<JsonRecord> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : { ...fallback };
  } catch (error) {
    if (isFileNotFoundError(error)) return { ...fallback };
    if (error instanceof SyntaxError && !strict) {
      logger.warn(
        CHANNEL,
        `Discarding unreadable ${filePath}; using the fallback snapshot.`,
        { data: error },
      );
      return { ...fallback };
    }
    throw error;
  }
}

/**
 * Pending flushes keyed by resolved store path. Module-wide (not per
 * instance) so writers holding separate `JsonStore` instances on the same
 * file preserve call order before entering the cross-process lock.
 */
const writeChains = new Map<string, Promise<void>>();

/**
 * File-backed key-value store, persisted as a flat JSON object.
 *
 * Shared building block for non-VS-Code platform implementations (Electron,
 * CLI). Writes go through `write-file-atomic`, which stages to a sibling temp
 * path, `fsync`s, then renames — so a crash mid-flush leaves the previous file
 * intact rather than corrupting the snapshot.
 *
 * Each `set()` flushes as a read-modify-write against the file rather than a
 * dump of this instance's in-memory snapshot: the flush re-reads the file and
 * applies only that one mutation, so an instance held open across an awaited
 * operation (e.g. a network fetch) can't clobber keys a concurrent writer —
 * another process, or another instance on the same file — persisted in the
 * meantime. Flushes for a given file path are chained through
 * {@link writeChains} for in-process ordering, then guarded by a filesystem
 * lock for cross-process exclusion. Reads (`get`, `has`, `snapshot`) still
 * serve this instance's view: open-time contents plus its own mutations; they
 * don't observe other writers' changes.
 */
export class JsonStore implements StateStore {
  private constructor(
    private readonly filePath: string,
    private data: JsonRecord,
    private readonly options: JsonStoreOptions,
  ) {}

  static async open(
    filePath: string,
    options: JsonStoreOptions = {},
  ): Promise<JsonStore> {
    const storePath = resolve(filePath);
    await ensureDir(dirname(storePath), options.mode);
    return new JsonStore(
      storePath,
      await readJsonRecord(storePath, options.strict ?? false),
      options,
    );
  }

  get<T>(key: string, defaultValue?: T): T {
    const value = this.data[key];
    return value === undefined ? (defaultValue as T) : (value as T);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.data, key);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.data[key];
    } else {
      this.data[key] = value;
    }
    await this.enqueueFlush(key, value, this.snapshot());
  }

  /** {@link StateStore} conformance; same persistence semantics as `set`. */
  update(key: string, value: unknown): Promise<void> {
    return this.set(key, value);
  }

  snapshot(): JsonRecord {
    return { ...this.data };
  }

  /**
   * Chain the flush onto the file's entry in {@link writeChains} so flushes
   * run in `set()` call order. The link is established synchronously, before
   * any await, so order is captured at call time rather than racing on
   * `mkdir`/read/`write-file-atomic` timing. A failed flush doesn't break the
   * chain (`.then(flush, flush)`).
   */
  private enqueueFlush(
    key: string,
    value: unknown,
    fallback: JsonRecord,
  ): Promise<void> {
    const flush = () => this.flush(key, value, fallback);
    const chain = writeChains.get(this.filePath) ?? Promise.resolve();
    const next = chain.then(flush, flush);
    writeChains.set(this.filePath, next);
    const deleteCompletedChain = () => {
      if (writeChains.get(this.filePath) === next) {
        writeChains.delete(this.filePath);
      }
    };
    void next.then(deleteCompletedChain, deleteCompletedChain);
    return next;
  }

  private async flush(
    key: string,
    value: unknown,
    fallback: JsonRecord,
  ): Promise<void> {
    await ensureDir(dirname(this.filePath), this.options.mode);
    const { lock } = await import('proper-lockfile');
    const release = await lock(this.filePath, {
      realpath: false,
      stale: LOCK_STALE_MS,
      retries: LOCK_RETRY_OPTIONS,
    });
    try {
      const record = await readJsonRecord(
        this.filePath,
        this.options.strict ?? false,
        fallback,
      );
      if (value === undefined) {
        delete record[key];
      } else {
        record[key] = value;
      }
      await writeFileAtomic(
        this.filePath,
        `${JSON.stringify(record, null, 2)}\n`,
        this.options.mode === undefined
          ? undefined
          : { mode: this.options.mode },
      );
    } finally {
      await release();
    }
  }
}

/**
 * Creates `dir` if missing. When `fileMode` is set, also chmods the
 * directory to {@link dirModeFor} — `mkdir`'s own `mode` only applies at
 * creation time, so a pre-existing directory with looser permissions needs
 * the explicit follow-up chmod too.
 */
async function ensureDir(
  dir: string,
  fileMode: number | undefined,
): Promise<void> {
  const dirMode = fileMode === undefined ? undefined : dirModeFor(fileMode);
  await mkdir(dir, { recursive: true, mode: dirMode });
  if (dirMode !== undefined) await chmod(dir, dirMode);
}
