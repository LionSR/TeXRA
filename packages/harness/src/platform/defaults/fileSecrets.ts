/**
 * The one credential store of every host (the CLI, the desktop app, the
 * VS Code extension and the background service): `~/.texra/secrets/`, a
 * directory only the user can open (0700) holding one file per key (0600).
 * The protection is the file mode, not keychain encryption, which is what
 * lets a background service read the keys a window saved.
 *
 * One file per key is what makes several processes safe without a lock:
 * a write replaces its own key's file by an atomic rename and reads no other
 * key, so two processes saving different keys cannot lose each other's
 * write, and two saving the same key leave the later one, as one process
 * would. Reads open the file each time, so they always see the current
 * value.
 */
import path from 'node:path';

import {
  Deferred,
  Effect,
  FileSystem,
  type PlatformError,
  Result,
  Schedule,
  Stream,
} from 'effect';

import { SecretsFailed, type SecretsOperation } from '@texra-ai/llm';
import { withLogChannel } from '@logger/effectLog';
import type { PlatformSecrets } from '@platform/secrets';
import { nodeFileServices } from '@utils/files/fsDurability';
import {
  meansAbsent,
  fileWatchRetrySchedule,
} from '@utils/files/fsEntryExists';
import { IS_WINDOWS } from '@utils/system/platformPaths';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  type PerKeyLane,
  type PerKeyLanes,
  withPerKeyLane,
} from '@utils/core/perKeyQueue';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** This prefix cannot occur in an encoded key: a percent escape has two
 *  hexadecimal digits. */
const STAGED_PREFIX = '%staged-';

/** One lane per key file, so this process's writes of one key keep their
 *  call order. */
const keyLanes: PerKeyLanes<string> = new Map<string, PerKeyLane>();

/** The file name of `key`: its URI encoding, which names every key. */
const fileNameOf = (key: string): string =>
  encodeURIComponent(key).replace(/^\./, '%2E');

/** Interpret a directory entry before announcing or listing it as a key. */
function keyFromFileName(
  directory: string,
  name: string,
): Effect.Effect<Result.Result<string, 'staged' | 'invalid'>> {
  if (name.startsWith(STAGED_PREFIX))
    return Effect.succeed(Result.fail('staged'));
  return Effect.gen(function* () {
    const decoded = Result.try({
      try: () => {
        const key = decodeURIComponent(name);
        return key !== '' && fileNameOf(key) === name ? key : undefined;
      },
      catch: toErrorMessage,
    });
    if (Result.isSuccess(decoded) && decoded.success !== undefined)
      return Result.succeed(decoded.success);
    yield* Effect.logWarning(
      `Invalid credential filename ${JSON.stringify(name)} in ${directory}: ${Result.isFailure(decoded) ? decoded.failure : 'expected an encoded key'}.`,
    );
    return Result.fail('invalid' as const);
  });
}

/** A credential store operation's failure at `directory`. */
function failure(
  directory: string,
  operation: SecretsOperation,
  cause: unknown,
  key?: string,
): SecretsFailed {
  return new SecretsFailed({
    operation,
    ...(key !== undefined && { key }),
    message: `Could not ${operation === 'get' || operation === 'listStoredKeys' ? 'read' : 'write'} the credential store at ${directory}: ${toErrorMessage(cause)}`,
    cause,
  });
}

/**
 * Windows refuses a rename while another handle holds either file open: a
 * process reading the key after a change, or a scanner on the file just
 * staged. The handle closes within milliseconds, so the rename is tried
 * again; elsewhere the same error is a real denial.
 */
const heldOpenOnWindows = (error: PlatformError.PlatformError): boolean =>
  IS_WINDOWS &&
  (error.reason._tag === 'PermissionDenied' || error.reason._tag === 'Busy');

const storedKeys = (directory: string) =>
  FileSystem.FileSystem.use((fs) => fs.readDirectory(directory)).pipe(
    Effect.catchIf(meansAbsent, () => Effect.succeed([])),
    Effect.mapError((cause) => failure(directory, 'listStoredKeys', cause)),
    Effect.flatMap((names) =>
      Effect.filterMapEffect(names, (name) => keyFromFileName(directory, name)),
    ),
  );

/**
 * A host's handle on the credential directory. `onChanged` is told "re-read
 * this key" after every write of this handle: the process's store announces
 * it (`credentialChanged`, `Secrets.announcing`), as
 * {@link FileSecrets.watch} does every other process's.
 */
export class FileSecrets implements PlatformSecrets {
  private readonly directory: string;
  private readonly onChanged: (key: string) => void;

  constructor(directory: string, onChanged: (key: string) => void) {
    this.directory = directory;
    this.onChanged = onChanged;
  }

  get(key: string): Effect.Effect<string | undefined, SecretsFailed> {
    return FileSystem.FileSystem.use((fs) =>
      fs.readFileString(this.fileOf(key)),
    ).pipe(
      Effect.catchIf(meansAbsent, () => Effect.undefined),
      Effect.mapError((cause) => failure(this.directory, 'get', cause, key)),
      Effect.provide(nodeFileServices),
    );
  }

  set(key: string, value: string): Effect.Effect<void, SecretsFailed> {
    const { directory } = this;
    const file = this.fileOf(key);
    return this.mutate(
      'set',
      key,
      Effect.fnUntraced(function* (fs) {
        yield* fs.makeDirectory(directory, {
          recursive: true,
          mode: DIRECTORY_MODE,
        });
        yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ directory, prefix: STAGED_PREFIX }),
          (staging) => {
            const staged = path.join(staging, 'value');
            // Write on the destination's filesystem, then replace the key's
            // directory entry in one rename.
            return fs.writeFileString(staged, value, { mode: FILE_MODE }).pipe(
              Effect.andThen(
                fs.rename(staged, file).pipe(
                  Effect.retry({
                    schedule: Schedule.exponential('10 millis'),
                    times: 6,
                    while: heldOpenOnWindows,
                  }),
                ),
              ),
              Effect.uninterruptible,
            );
          },
          (staging) =>
            fs.remove(staging, { recursive: true, force: true }).pipe(
              Effect.ignore({
                log: 'Warn',
                message: `A credential staging directory stays behind: ${staging}`,
              }),
            ),
        );
      }),
    );
  }

  delete(key: string): Effect.Effect<void, SecretsFailed> {
    return this.mutate('delete', key, (fs) =>
      fs.remove(this.fileOf(key), { force: true }),
    );
  }

  /** A stray filename is warned about and left out of the key listing. */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return storedKeys(this.directory).pipe(
      Effect.provide(nodeFileServices),
      withLogChannel('secrets'),
    );
  }

  /**
   * `announce` every key another process writes under `directory`, for as
   * long as the caller's fiber runs. Reconcile existing keys when each
   * watch is installed, then announce individual file changes. A failed
   * watch retries with backoff before reporting that it stopped.
   */
  static watch<R>(
    directory: string,
    announce: (key: string) => Effect.Effect<void, never, R>,
  ): Effect.Effect<void, never, FileSystem.FileSystem | R> {
    const stopped = (reason: string) =>
      Effect.logWarning(
        `Stopped watching ${directory}: keys another process saves apply here after a restart (${reason})`,
      );
    const announceAll = storedKeys(directory).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(keys, announce, { discard: true }),
      ),
      Effect.catch((error) => Effect.logWarning(error.message)),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(directory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      // Each subscription (including a retry) lists the keys after the
      // filesystem has installed its watcher and can buffer events.
      const changes = Stream.unwrap(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          return fs
            .watch(directory, {
              onReady: () => {
                Deferred.doneUnsafe(ready, Effect.void);
              },
            })
            .pipe(
              Stream.mergeEffect(
                Deferred.await(ready).pipe(Effect.andThen(announceAll)),
              ),
            );
        }),
      );
      yield* changes.pipe(
        Stream.retry(fileWatchRetrySchedule),
        Stream.runForEach((event) =>
          keyFromFileName(directory, path.basename(event.path)).pipe(
            Effect.flatMap((entry) => {
              if (Result.isSuccess(entry)) return announce(entry.success);
              // The watcher can report just the staging name, with no key.
              return entry.failure === 'staged' ? announceAll : Effect.void;
            }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) => stopped(toErrorMessage(cause))),
      withLogChannel('secrets'),
    );
  }

  private fileOf(key: string): string {
    return path.join(this.directory, fileNameOf(key));
  }

  /**
   * One write of one key, in this process's call order for that key. The
   * commit survives a cancelled caller; `onChanged` runs on every exit,
   * because a commit that landed still exits as interrupted when its caller
   * was cancelled.
   */
  private mutate(
    operation: Extract<SecretsOperation, 'set' | 'delete'>,
    key: string,
    write: (
      fs: FileSystem.FileSystem,
    ) => Effect.Effect<void, PlatformError.PlatformError>,
  ): Effect.Effect<void, SecretsFailed> {
    return withPerKeyLane(
      keyLanes,
      this.fileOf(key),
    )(FileSystem.FileSystem.use(write)).pipe(
      Effect.mapError((cause) =>
        failure(this.directory, operation, cause, key),
      ),
      Effect.ensuring(Effect.sync(() => this.onChanged(key))),
      Effect.provide(nodeFileServices),
    );
  }
}

/** The credential directory under a storage root (`~/.texra` in
 *  production). */
export function secretsDirectory(storageRoot: string): string {
  return path.join(storageRoot, 'secrets');
}
