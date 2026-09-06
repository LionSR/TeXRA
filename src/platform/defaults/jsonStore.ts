import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Cause, Effect, Exit } from 'effect';
import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import type { StateStore } from '../interfaces';
import type { FileLockTuning } from './fileLocks';

/**
 * Cross-process lock policy for the read-modify-write flush below, tuned
 * for this store's short, frequent flushes rather than long-running work.
 * `fileLocks` itself is loaded on the first flush so importing `JsonStore`
 * doesn't pull in `proper-lockfile` before any write actually happens.
 */
const FLUSH_LOCK_TUNING: FileLockTuning = {
  staleMs: 10_000,
  retries: {
    retries: 120,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 100,
  },
};
const fileLocks = Effect.promise(() => import('./fileLocks.js'));

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

/**
 * Read the store file as a JSON object. A missing file reads as a copy of
 * `missingFallback`; unreadable or non-object content fails with the
 * original error (`SyntaxError`, `TypeError`, or the fs error). The mappers
 * only name those types — the foreign-boundary adapter case of PRD R7, kept
 * untagged because `JsonStore.open` rethrows the same instances.
 */
const readJsonRecord = Effect.fn('JsonStore.readJsonRecord')(function* (
  filePath: string,
  missingFallback: JsonRecord = {},
) {
  const content = yield* Effect.tryPromise({
    try: () => readFile(filePath, 'utf8'),
    catch: (cause) => cause as NodeJS.ErrnoException,
  }).pipe(Effect.catchIf(isFileNotFoundError, () => Effect.succeed(undefined)));
  if (content === undefined) return { ...missingFallback };
  const parsed = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: (cause) => cause as SyntaxError,
  });
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as JsonRecord;
  }
  return yield* Effect.fail(
    new TypeError(`Expected ${filePath} to contain a JSON object.`),
  );
});

/**
 * Creates `dir` if missing. When `fileMode` is set, also chmods the
 * directory to {@link dirModeFor} — `mkdir`'s own `mode` only applies at
 * creation time, so a pre-existing directory with looser permissions needs
 * the explicit follow-up chmod too.
 */
const ensureDir = Effect.fn('JsonStore.ensureDir')(function* (
  dir: string,
  fileMode: number | undefined,
) {
  const dirMode = fileMode === undefined ? undefined : dirModeFor(fileMode);
  yield* Effect.tryPromise({
    try: () => mkdir(dir, { recursive: true, mode: dirMode }),
    catch: (cause) => cause as NodeJS.ErrnoException,
  });
  if (dirMode !== undefined) {
    yield* Effect.tryPromise({
      try: () => chmod(dir, dirMode),
      catch: (cause) => cause as NodeJS.ErrnoException,
    });
  }
});

/**
 * One-at-a-time flush lane per resolved store path. Module-wide (not per
 * instance) so writers holding separate `JsonStore` instances on the same
 * file preserve call order before entering the cross-process lock.
 */
const writeLanes = new Map<string, PerKeyLane>();

/**
 * Persist one mutation as a read-modify-write under the file's cross-process
 * lock: prepare the directory, re-read the file (falling back to
 * `missingFallback` when it is gone), apply the mutation, and write the
 * result atomically.
 */
const flush = Effect.fn('JsonStore.flush')(function* (
  filePath: string,
  mode: number | undefined,
  key: string,
  value: unknown,
  missingFallback: JsonRecord,
) {
  yield* ensureDir(dirname(filePath), mode);
  const { withFileLock } = yield* fileLocks;
  yield* withFileLock(
    filePath,
    FLUSH_LOCK_TUNING,
  )(
    Effect.gen(function* () {
      const record = yield* readJsonRecord(filePath, missingFallback);
      if (value === undefined) {
        delete record[key];
      } else {
        record[key] = value;
      }
      yield* Effect.tryPromise({
        try: () =>
          writeFileAtomic(
            filePath,
            `${JSON.stringify(record, null, 2)}\n`,
            mode === undefined ? undefined : { mode },
          ),
        catch: (cause) => cause as NodeJS.ErrnoException,
      });
    }),
  );
});

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
 * {@link writeLanes} for in-process ordering, then guarded by a filesystem
 * lock for cross-process exclusion. Reads (`get`, `has`, `snapshot`, `keys`)
 * still serve this instance's view: open-time contents plus its own
 * mutations; they don't observe other writers' changes.
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
    // Runs on Effect's default runtime, not `effectRuntime()`: the CLI and
    // desktop hosts open their stores before `installProcessRuntime` — the
    // CLI's `initPlatform` calls `createCliStateStores` and
    // `openTexraConfigStores` first — so the process runtime does not exist
    // yet. Pinned by the "Effect run boundaries" ratchet in
    // src/test-kernel/architecture/dependencyDirection.vitest.ts.
    const exit = await Effect.runPromiseExit(readJsonRecord(storePath));
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    return new JsonStore(storePath, exit.value, options);
  }

  get<T>(key: string, defaultValue?: T): T {
    const value = this.data[key];
    return value === undefined ? (defaultValue as T) : (value as T);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.data, key);
  }

  /**
   * Apply the mutation in memory, then flush it on the file's lane in
   * {@link writeLanes}. The lane is claimed synchronously, before any
   * await, so flushes run in `set()` call order rather than racing on
   * `mkdir`/read/`write-file-atomic` timing; a failed flush doesn't stop
   * the lane from running subsequent flushes.
   */
  async set(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.data[key];
    } else {
      this.data[key] = value;
    }
    // Default runtime for the same reason as `open`: a store opened during
    // host bootstrap is written through this same entry, and this module
    // sits below the runtime install, so no entry here may assume
    // `installProcessRuntime` has run. Pinned by the same "Effect run
    // boundaries" ratchet.
    const exit = await Effect.runPromiseExit(
      withPerKeyLane(
        writeLanes,
        this.filePath,
      )(flush(this.filePath, this.options.mode, key, value, this.snapshot())),
    );
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  }

  /** {@link StateStore} conformance; same persistence semantics as `set`. */
  update(key: string, value: unknown): Promise<void> {
    return this.set(key, value);
  }

  snapshot(): JsonRecord {
    return { ...this.data };
  }

  keys(): string[] {
    return Object.keys(this.data);
  }
}
