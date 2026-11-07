// Node imports
import { Buffer } from 'node:buffer';
import { readFileSync, statSync } from 'node:fs';

// Third-party imports
import {
  Effect,
  FileSystem,
  Path,
  type PlatformError,
  Predicate,
} from 'effect';

// Local imports
import { writeLogLine } from '@logger/logSink';
import { ensureError } from '@utils/errors/errorMessage';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { nodeFileServices, writeFileAtomic } from '@utils/files/fsDurability';
import { absentReason } from '@utils/files/fsEntryExists';

type JsonRecord = Record<string, unknown>;

/** Preserve the Node error identity exposed by this store's existing callers. */
function storageError(error: PlatformError.PlatformError): Error {
  return ensureError(error.reason.cause ?? error);
}

/** The file's version as a read compares it: absent, or its identity. */
function fileVersion(filePath: string): string {
  const stat = statSync(filePath, { throwIfNoEntry: false });
  return stat === undefined
    ? 'absent'
    : `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/** The file's record, read synchronously as a read follows the file. */
function readJsonRecordSync(filePath: string): JsonRecord {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (absentReason(error)) return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (Predicate.isObject(parsed)) return parsed;
  throw new TypeError(`Expected ${filePath} to contain a JSON object.`);
}

/**
 * Read the store file as a JSON object. A missing file reads as a copy of
 * `missingFallback`; unreadable or non-object content fails with the
 * original error (`SyntaxError`, `TypeError`, or the Node filesystem error).
 * The standard filesystem service's error is unwrapped at this store boundary
 * because its existing callers match the underlying Node errors.
 */
const readJsonRecord = Effect.fn('JsonStore.readJsonRecord')(function* (
  filePath: string,
  missingFallback: JsonRecord = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFile(filePath).pipe(
    // Preserve the existing UTF-8 decoding, including a leading BOM.
    Effect.map((bytes) => Buffer.from(bytes).toString('utf8')),
    Effect.catchIf(absentReason, () => Effect.void),
    Effect.mapError(storageError),
  );
  if (content === undefined) return { ...missingFallback };
  const parsed: unknown = yield* Effect.try({
    try: () => JSON.parse(content),
    // JSON.parse throws a SyntaxError, which passes through unchanged.
    catch: ensureError,
  });
  if (Predicate.isObject(parsed)) return parsed;
  return yield* Effect.fail(
    new TypeError(`Expected ${filePath} to contain a JSON object.`),
  );
});

/**
 * One-at-a-time flush lane per resolved store path. Module-wide (not per
 * instance) so writers holding separate `JsonStore` instances on the same
 * file preserve call order.
 */
const writeLanes = new Map<string, PerKeyLane>();

/**
 * Persist one mutation as a read-modify-write: prepare the directory, re-read
 * the file (falling back to `missingFallback` when it is gone), apply the
 * mutation, and write the result atomically.
 */
const flush = Effect.fn('JsonStore.flush')(function* (
  filePath: string,
  key: string,
  value: unknown,
  missingFallback: JsonRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(path.dirname(filePath), { recursive: true })
    .pipe(Effect.mapError(storageError));
  const record = yield* readJsonRecord(filePath, missingFallback);
  if (value === undefined) {
    delete record[key];
  } else {
    record[key] = value;
  }
  yield* writeFileAtomic(
    filePath,
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
  ).pipe(Effect.mapError(storageError));
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
 * {@link writeLanes}, which orders this process's writers; across processes
 * the atomic rename is the only guarantee, so two hosts flushing the same file
 * in the same instant can still lose one of the two mutations. Reads (`get`,
 * `snapshot`, `keys`) follow the file: each compares its inode, mtime and
 * size with the version the view was read from (about a microsecond) and
 * re-reads it when they differ, so another process's or another instance's
 * write is served; a `set` still queued behind another one has changed
 * nothing yet. A changed file that cannot be read keeps the last view and
 * is logged once per version of the file.
 *
 * `set` is the store's own write and is an `Effect`, requirement-free: it
 * provides the Node filesystem services its flush reads and writes through, so
 * a port that composes it (the config store) needs no filesystem in its own
 * type. Application state is owned by SQLite and secrets by `FileSecrets`;
 * this store serves deliberate configuration files.
 */
export class JsonStore {
  /** The file version `data` was read from: undefined re-reads it. */
  private version: string | undefined;

  readonly filePath: string;
  private data: JsonRecord;
  private constructor(
    /** The file this store reads and writes; warnings name it. */
    filePath: string,
    data: JsonRecord,
    version: string | undefined,
  ) {
    this.filePath = filePath;
    this.data = data;
    this.version = version;
  }

  /**
   * The store's view, brought up to the file's current version.
   * The version is read before the record and again after it, so a write
   * landing between the two is read next time rather than taken for the
   * version already held. A file that cannot be probed or read keeps the
   * view and is reported once per failure.
   */
  private current(): JsonRecord {
    try {
      const version = fileVersion(this.filePath);
      if (version === this.version) return this.data;
      const data = readJsonRecordSync(this.filePath);
      this.data = data;
      this.version =
        fileVersion(this.filePath) === version ? version : undefined;
    } catch (error) {
      const failed = `failed:${ensureError(error).message}`;
      // `get` is synchronous and reached from fibers and plain calls
      // alike, so the report goes straight to the sink.
      if (this.version !== failed) {
        writeLogLine(
          'jsonStore',
          `${this.filePath} changed but could not be read; the settings read before stay in effect until it is fixed: ${ensureError(error).message}`,
        );
      }
      this.version = failed;
    }
    return this.data;
  }

  /**
   * Opening is read-only: a missing file reads as an empty store, and the
   * containing directory is not created here — that happens in
   * {@link flush}, so pure reads work on read-only or unowned storage.
   */
  static readonly open = Effect.fn('JsonStore.open')(function* (
    filePath: string,
  ) {
    const path = yield* Path.Path;
    const storePath = path.resolve(filePath);
    // The version is taken before the read, so a write landing during it
    // is read again at the first `get`.
    const version = fileVersion(storePath);
    const data = yield* readJsonRecord(storePath);
    return new JsonStore(storePath, data, version);
  });

  /**
   * The store over a file that exists but cannot be read as a JSON object
   * (`open` failed on it): an empty view held at the file's current version,
   * so it reads the file again once the file changes. Writes still re-read
   * the file in {@link flush}, so they fail rather than overwrite what could
   * not be parsed.
   */
  static readonly unreadable = Effect.fn('JsonStore.unreadable')(function* (
    filePath: string,
  ) {
    const path = yield* Path.Path;
    const storePath = path.resolve(filePath);
    return new JsonStore(storePath, {}, fileVersion(storePath));
  });

  get(key: string): unknown {
    return this.current()[key];
  }

  /**
   * Commit one mutation: take the file's lane in {@link writeLanes}, flush
   * it, and only once the flush has succeeded apply it to this instance's
   * record — a failed flush (e.g. a store opened over an unreadable file,
   * {@link JsonStore.unreadable}) leaves `get` serving what it
   * served before, never a value that did not reach disk. Because the lane
   * serializes every commit on the file, no later `set` can apply between
   * this one's flush and its in-memory apply, so there is nothing to roll
   * back and no ordering to reconcile. Lanes are claimed
   * in the effect's first synchronous step, so commits run in `set()` order
   * rather than racing on `mkdir`/read/`write-file-atomic` timing; a failed
   * flush doesn't stop the lane from running subsequent commits.
   *
   * Waiting for the lane is interruptible, the commit behind it is not — and
   * the in-memory mutation is the tail of that commit, not part of the wait.
   * A writer cancelled while queued leaves the record and the file exactly as it found
   * them; one that has entered the lane runs its read-modify-write to
   * completion rather than leaving the file holding a record it read before
   * another writer's mutation, or leaving this instance serving a value that
   * never reached disk — the store outlives the fiber that wrote through it,
   * so a mutation applied ahead of the wait would survive a cancellation that
   * wrote nothing and read as committed until the process restarts. There is
   * one mutator: removal uses `set(key, undefined)` in this same region.
   */
  set(key: string, value: unknown): Effect.Effect<void, Error> {
    return withPerKeyLane(
      writeLanes,
      this.filePath,
    )(
      Effect.uninterruptible(
        Effect.suspend(() =>
          Effect.provide(
            flush(this.filePath, key, value, this.snapshot()),
            nodeFileServices,
          ),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (value === undefined) {
                delete this.data[key];
              } else {
                this.data[key] = value;
              }
            }),
          ),
        ),
      ),
    );
  }

  snapshot(): Record<string, unknown> {
    return { ...this.current() };
  }

  keys(): string[] {
    return Object.keys(this.current());
  }
}
