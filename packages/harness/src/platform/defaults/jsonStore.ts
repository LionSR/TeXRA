// Node imports
import { Buffer } from 'node:buffer';
import { readFileSync, statSync } from 'node:fs';

// Third-party imports
import {
  Effect,
  FileSystem,
  Layer,
  Path,
  type PlatformError,
  Predicate,
} from 'effect';
import { NodeFileSystem, NodePath } from '@effect/platform-node';
import writeFileAtomic from 'write-file-atomic';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { ensureError } from '@utils/errors/errorMessage';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

type JsonRecord = Record<string, unknown>;

/**
 * The filesystem services a `JsonStore` reads and writes over, as a layer a
 * caller can provide itself. This store provides them for its own write
 * ({@link JsonStore.set}) and for `update`'s runner, so no consumer of a
 * requirement-free port carries `FileSystem | Path` in its type.
 */
export const nodeFileServices: Layer.Layer<FileSystem.FileSystem | Path.Path> =
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** Preserve the Node error identity exposed by this store's existing callers. */
function storageError(error: PlatformError.PlatformError): Error {
  return ensureError(error.reason.cause ?? error);
}

interface JsonStoreOptions {
  /**
   * When set, a file that exists but cannot be read as a JSON object opens as
   * an empty view and reports the cause here instead of failing the open.
   * Writes still re-read the file in {@link flush}, so they fail rather than
   * overwrite what the reader could not parse.
   */
  onUnreadable?: (error: Error) => void;
  /**
   * Serve other writers' changes: every read first compares the file's
   * inode, mtime and size with the version it holds (about a microsecond)
   * and re-reads the file when they differ. A long-lived process that other
   * processes configure (the TeXRA service) opens its stores this way. A
   * changed file it cannot read keeps the last view and is reported here,
   * once per version of the file.
   */
  follow?: (error: Error) => void;
}

/** The file's version as a read compares it: absent, or its identity. */
function fileVersion(filePath: string): string {
  const stat = statSync(filePath, { throwIfNoEntry: false });
  return stat === undefined
    ? 'absent'
    : `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/** The file's record, read synchronously for {@link JsonStoreOptions.follow}. */
function readJsonRecordSync(filePath: string): JsonRecord {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) return {};
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
    Effect.mapError(storageError),
    Effect.catchIf(isFileNotFoundError, () => Effect.succeed(undefined)),
  );
  if (content === undefined) return { ...missingFallback };
  const parsed = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: (cause) => cause as SyntaxError,
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
  yield* Effect.tryPromise({
    try: () =>
      writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`),
    catch: (cause) => cause as NodeJS.ErrnoException,
  });
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
 * `snapshot`, `keys`) still serve this instance's view: open-time
 * contents plus its own committed mutations — a `set` still queued behind
 * another one has changed nothing yet; they don't observe other writers'
 * changes.
 *
 * `set` is the store's own write and is an `Effect`, requirement-free: it
 * provides the Node filesystem services its flush reads and writes through, so
 * a port that composes it (the config store) needs no filesystem in its own
 * type. Application state is owned by SQLite and secrets by `FileSecrets`;
 * this store serves deliberate configuration files.
 */
export class JsonStore {
  /** The file version `data` was read from, when the store follows it. */
  private version: string | undefined;
  private readonly follow: ((error: Error) => void) | undefined;

  private constructor(
    /** The file this store reads and writes; warnings name it. */
    readonly filePath: string,
    private data: JsonRecord,
    follow: ((error: Error) => void) | undefined,
  ) {
    this.follow = follow;
  }

  /**
   * A following store's view, brought up to the file's current version.
   * The version is read before the record and again after it, so a write
   * landing between the two is read next time rather than taken for the
   * version already held. A file that cannot be probed or read keeps the
   * view and is reported once per failure.
   */
  private current(): JsonRecord {
    const follow = this.follow;
    if (follow === undefined) return this.data;
    try {
      const version = fileVersion(this.filePath);
      if (version === this.version) return this.data;
      const data = readJsonRecordSync(this.filePath);
      this.data = data;
      this.version =
        fileVersion(this.filePath) === version ? version : undefined;
    } catch (error) {
      const failed = `failed:${ensureError(error).message}`;
      if (this.version !== failed) follow(ensureError(error));
      this.version = failed;
    }
    return this.data;
  }

  /**
   * Opening is read-only: a missing file reads as an empty store, and the
   * containing directory is not created here — that happens in
   * {@link flush}, so pure reads work on read-only or unowned storage
   * (#8220).
   */
  static readonly open = Effect.fn('JsonStore.open')(function* (
    filePath: string,
    options: JsonStoreOptions = {},
  ) {
    const path = yield* Path.Path;
    const storePath = path.resolve(filePath);
    const { onUnreadable } = options;
    const data = yield* onUnreadable
      ? readJsonRecord(storePath).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              onUnreadable(ensureError(error));
              return {};
            }),
          ),
        )
      : readJsonRecord(storePath);
    return new JsonStore(storePath, data, options.follow);
  });

  get<T>(key: string): T | undefined {
    return this.current()[key] as T | undefined;
  }

  /**
   * Commit one mutation: take the file's lane in {@link writeLanes}, flush
   * it, and only once the flush has succeeded apply it to this instance's
   * record — a failed flush (e.g. a store opened over an unreadable file via
   * {@link JsonStoreOptions.onUnreadable}) leaves `get` serving what it
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

  snapshot(): JsonRecord {
    return { ...this.current() };
  }

  keys(): string[] {
    return Object.keys(this.current());
  }
}
