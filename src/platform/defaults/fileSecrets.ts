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
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  Cause,
  Effect,
  FileSystem,
  type PlatformError,
  Schedule,
  Stream,
} from 'effect';

import { SecretsFailed, type SecretsOperation } from '@texra-ai/llm';
import type { PlatformSecrets } from '@platform/secrets';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import { absentReason } from '@utils/files/fsEntryExists';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  type PerKeyLane,
  type PerKeyLanes,
  withPerKeyLane,
} from '@utils/core/perKeyQueue';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** A staged write's name: `%` never starts an encoded key, so a listing
 *  tells a staged file from a key without parsing it. */
const STAGED_PREFIX = '%staged-';

/** One lane per key file, so this process's writes of one key keep their
 *  call order. */
const keyLanes: PerKeyLanes<string> = new Map<string, PerKeyLane>();

/** The file name of `key`: its URI encoding, which names every key. */
const fileNameOf = (key: string): string =>
  encodeURIComponent(key).replace(/^\./, '%2E');

/**
 * A host's handle on the credential directory. `onChanged` is the host's
 * "re-read this key" signal (`credentialChanged`), told after every write
 * of this process and, through {@link FileSecrets.watch}, of every other.
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
      Effect.map((value): string | undefined => value),
      Effect.catchIf(absentReason, () => Effect.succeed(undefined)),
      Effect.mapError((cause) => this.failure('get', cause, key)),
      Effect.provide(nodeFileServices),
    );
  }

  set(key: string, value: string): Effect.Effect<void, SecretsFailed> {
    const { directory } = this;
    const file = this.fileOf(key);
    return this.mutate('set', key, (fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, {
          recursive: true,
          mode: DIRECTORY_MODE,
        });
        const staged = path.join(directory, `${STAGED_PREFIX}${randomUUID()}`);
        // The commit: the staged file becomes the key's in one rename, so a
        // reader sees the old value or the new one, never a partial file.
        yield* fs.writeFileString(staged, value, { mode: FILE_MODE }).pipe(
          Effect.andThen(fs.rename(staged, file)),
          Effect.onError(() =>
            fs.remove(staged, { force: true }).pipe(
              Effect.ignore({
                log: 'Warn',
                message: `A staged credential file stays behind: ${staged}`,
              }),
            ),
          ),
          Effect.uninterruptible,
        );
      }),
    );
  }

  delete(key: string): Effect.Effect<void, SecretsFailed> {
    return this.mutate('delete', key, (fs) =>
      fs.remove(this.fileOf(key), { force: true }),
    );
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return FileSystem.FileSystem.use((fs) =>
      fs.readDirectory(this.directory),
    ).pipe(
      Effect.map((names) =>
        names
          .filter((name) => !name.startsWith(STAGED_PREFIX))
          .map((name) => decodeURIComponent(name)),
      ),
      Effect.catchIf(absentReason, () => Effect.succeed([])),
      Effect.mapError((cause) => this.failure('listStoredKeys', cause)),
      Effect.provide(nodeFileServices),
    );
  }

  /**
   * Tell `onChanged` about every key another process writes, for as long as
   * the caller's fiber runs: once for every stored key when the watch is up
   * (what changed before it began), then per key as its file changes. A
   * watch that fails is retried with backoff before it is given up, loudly.
   */
  watch(): Effect.Effect<void, never, FileSystem.FileSystem> {
    const { directory, onChanged } = this;
    const stopped = (reason: string) =>
      Effect.logWarning(
        `Stopped watching ${directory}: keys another TeXRA window saves apply here after a restart (${reason})`,
      );
    const announceAll = this.listStoredKeys().pipe(
      Effect.flatMap((keys) =>
        Effect.sync(() => {
          for (const key of keys) onChanged(key);
        }),
      ),
      Effect.catch((error) => stopped(error.message)),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(directory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      yield* fs.watch(directory).pipe(
        Stream.retry(
          Schedule.exponential('1 second').pipe(
            Schedule.upTo({ times: 5 }),
            Schedule.while(
              ({ input }: { readonly input: PlatformError.PlatformError }) =>
                input.reason._tag === 'Unknown',
            ),
          ),
        ),
        Stream.map((event) => path.basename(event.path)),
        // A staged file's rename is reported under either name: the key's
        // file says which key, a staged name (macOS) only that one changed.
        Stream.runForEach((name) =>
          name.startsWith(STAGED_PREFIX)
            ? announceAll
            : Effect.sync(() => onChanged(decodeURIComponent(name))),
        ),
        // fs.watch can also throw synchronously (EMFILE, ENOSPC): a defect.
        Effect.catchCause((cause) =>
          stopped(toErrorMessage(Cause.squash(cause))),
        ),
        // Watching before the first listing, so no write falls between.
        (watching) => Effect.forkScoped(watching, { startImmediately: true }),
      );
      yield* announceAll;
      yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        stopped(toErrorMessage(Cause.squash(cause))),
      ),
    );
  }

  private fileOf(key: string): string {
    return path.join(this.directory, fileNameOf(key));
  }

  private failure(
    operation: SecretsOperation,
    cause: unknown,
    key?: string,
  ): SecretsFailed {
    return new SecretsFailed({
      reason: 'io',
      operation,
      ...(key !== undefined && { key }),
      message: `Could not ${operation === 'get' || operation === 'listStoredKeys' ? 'read' : 'write'} the credential store at ${this.directory}: ${toErrorMessage(cause)}`,
      cause,
    });
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
      Effect.mapError((cause) => this.failure(operation, cause, key)),
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
