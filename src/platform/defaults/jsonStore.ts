// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { NodeFileSystem, NodePath } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Path, type PlatformError } from 'effect';
import writeFileAtomic from 'write-file-atomic';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { effectRuntime } from '@platform/processRuntime';
import { ensureError } from '@utils/errors/errorMessage';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import type { StateStore } from '../interfaces';

type JsonRecord = Record<string, unknown>;

const nodeStorageLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** Preserve the Node error identity exposed by this store's existing callers. */
function storageError(error: PlatformError.PlatformError): Error {
  return ensureError(error.reason.cause ?? error);
}

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
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .makeDirectory(dir, { recursive: true, mode: dirMode })
    .pipe(Effect.mapError(storageError));
  if (dirMode !== undefined) {
    yield* fs.chmod(dir, dirMode).pipe(Effect.mapError(storageError));
  }
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
  mode: number | undefined,
  key: string,
  value: unknown,
  missingFallback: JsonRecord,
) {
  const path = yield* Path.Path;
  yield* ensureDir(path.dirname(filePath), mode);
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
 * `has`, `snapshot`, `keys`) still serve this instance's view: open-time
 * contents plus its own mutations; they don't observe other writers' changes.
 *
 * `set` is the store's own write and is an `Effect`. `update` exists only
 * because {@link StateStore} and `ConfigStore` mirror `vscode.Memento`, whose
 * shape the VS Code host cannot change: it is the port's method, the single
 * place this module reaches the process runtime, and it disappears with those
 * two port shapes rather than with this class.
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
  static readonly open = Effect.fn('JsonStore.open')(function* (
    filePath: string,
    options: JsonStoreOptions = {},
  ) {
    const path = yield* Path.Path;
    const storePath = path.resolve(filePath);
    return new JsonStore(storePath, yield* readJsonRecord(storePath), options);
  }, Effect.provide(nodeStorageLayer));

  get<T>(key: string, defaultValue?: T): T {
    const value = this.data[key];
    return value === undefined ? (defaultValue as T) : (value as T);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.data, key);
  }

  /**
   * Apply the mutation in memory, then flush it on the file's lane in
   * {@link writeLanes}. Both steps happen in the effect's first synchronous
   * step, so flushes run in `set()` order rather than racing on
   * `mkdir`/read/`write-file-atomic` timing; a failed flush doesn't stop the
   * lane from running subsequent flushes.
   */
  set(key: string, value: unknown) {
    return Effect.suspend(() => {
      if (value === undefined) {
        delete this.data[key];
      } else {
        this.data[key] = value;
      }
      return withPerKeyLane(
        writeLanes,
        this.filePath,
      )(
        flush(
          this.filePath,
          this.options.mode,
          key,
          value,
          this.snapshot(),
        ).pipe(Effect.provide(nodeStorageLayer)),
      );
    });
  }

  /**
   * {@link StateStore} / `ConfigStore` conformance — the `vscode.Memento`
   * shape both ports mirror. Same persistence semantics as {@link set},
   * which is the Effect-side write every caller inside a program uses.
   */
  update(key: string, value: unknown): Promise<void> {
    return effectRuntime().runPromise(this.set(key, value));
  }

  snapshot(): JsonRecord {
    return { ...this.data };
  }

  keys(): string[] {
    return Object.keys(this.data);
  }
}
