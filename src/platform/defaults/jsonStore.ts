import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import PQueue from 'p-queue';
import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';

import type { FileLockProvider, StateStore } from '../interfaces';

/**
 * Cross-process lock for the read-modify-write flush below. Shares its
 * mechanics (KeyedMutex in-process serialization, onCompromised handling,
 * error aggregation) with `fileLocks.ts`'s other callers, tuned for this
 * store's short, frequent flushes rather than long-running work. Loaded
 * lazily, on first flush, so importing `JsonStore` doesn't pull in
 * `proper-lockfile` before any write actually happens.
 */
let jsonStoreFileLocksPromise: Promise<FileLockProvider> | undefined;
function getJsonStoreFileLocks(): Promise<FileLockProvider> {
  jsonStoreFileLocksPromise ??= import('./fileLocks.js').then(
    ({ createNodeFileLocks }) =>
      createNodeFileLocks({
        staleMs: 10_000,
        retries: {
          retries: 120,
          factor: 1.2,
          minTimeout: 10,
          maxTimeout: 100,
        },
      }),
  );
  return jsonStoreFileLocksPromise;
}

type JsonRecord = Record<string, unknown>;

export interface JsonStoreOptions {
  /**
   * POSIX mode for the store file (e.g. `0o600` to restrict a secrets file
   * to its owner). The containing directory is created/chmod'd with the
   * same owner permissions plus execute — `0o600` -> `0o700` — so it stays
   * traversable. Directory creation and hardening happen only on the write
   * path (`flush`), never in `open()`: reads must keep working against
   * read-only or unowned storage (e.g. env-var-only CLI credential checks
   * on a container-mounted state dir — #8220). Left unset,
   * `mkdir`/`writeFileAtomic` use their platform defaults, matching prior
   * `JsonStore` behavior.
   */
  mode?: number;
}

/** `0o600` -> `0o700`: adds owner-execute wherever owner-read is set. */
function dirModeFor(fileMode: number): number {
  return fileMode | ((fileMode & 0o444) >> 2);
}

async function readJsonRecord(
  filePath: string,
  missingFallback: JsonRecord = {},
): Promise<JsonRecord> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }
    throw new TypeError(`Expected ${filePath} to contain a JSON object.`);
  } catch (error) {
    if (isFileNotFoundError(error)) return { ...missingFallback };
    throw error;
  }
}

/**
 * One-at-a-time flush queue per resolved store path. Module-wide (not per
 * instance) so writers holding separate `JsonStore` instances on the same
 * file preserve call order before entering the cross-process lock.
 */
const writeQueues = new Map<string, PQueue>();

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
 * meantime. Flushes for a given file path are serialized through
 * {@link writeQueues} for in-process ordering, then guarded by a filesystem
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

  /**
   * Opening is read-only: a missing file reads as an empty store, and the
   * containing directory is neither created nor chmod'd here — that happens
   * in {@link flush}, so pure reads work on storage the process can't write
   * (see {@link JsonStoreOptions.mode}).
   */
  static async open(
    filePath: string,
    options: JsonStoreOptions = {},
  ): Promise<JsonStore> {
    const storePath = resolve(filePath);
    return new JsonStore(storePath, await readJsonRecord(storePath), options);
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
   * Add the flush to the file's entry in {@link writeQueues} so flushes run
   * in `set()` call order. The task is enqueued synchronously, before any
   * await, so order is captured at call time rather than racing on
   * `mkdir`/read/`write-file-atomic` timing. A failed flush doesn't stop the
   * queue from running subsequent flushes.
   */
  private enqueueFlush(
    key: string,
    value: unknown,
    missingFallback: JsonRecord,
  ): Promise<void> {
    let queue = writeQueues.get(this.filePath);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      writeQueues.set(this.filePath, queue);
    }
    // `add` widens to `T | void` to cover abort via signal/timeout; we pass
    // neither, so the task always runs and resolves with `void`.
    const task = queue.add(() =>
      this.flush(key, value, missingFallback),
    ) as Promise<void>;
    return task.finally(() => {
      if (
        queue.pending === 0 &&
        queue.size === 0 &&
        writeQueues.get(this.filePath) === queue
      ) {
        writeQueues.delete(this.filePath);
      }
    });
  }

  private async flush(
    key: string,
    value: unknown,
    missingFallback: JsonRecord,
  ): Promise<void> {
    await ensureDir(dirname(this.filePath), this.options.mode);
    const fileLocks = await getJsonStoreFileLocks();
    await fileLocks.runExclusive(this.filePath, async () => {
      const record = await readJsonRecord(this.filePath, missingFallback);
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
    });
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
