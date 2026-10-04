// Node imports
import path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Stream } from 'effect';

// Local imports
import { SecretsFailed, type SecretsOperation } from '@texra-ai/llm';
import type { PlatformSecrets } from '@platform/secrets';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  type PerKeyLane,
  type PerKeyLanes,
  withPerKeyLane,
} from '@utils/core/perKeyQueue';

/** Secrets file is owner-only: `0o600` (containing dir gets `0o700`). */
const SECRETS_FILE_MODE = 0o600;

/**
 * One mutation lane per secrets file, so two instances over the same path
 * still write in call order before entering the cross-process lock.
 */
const mutationLanes: PerKeyLanes<string> = new Map<string, PerKeyLane>();

/**
 * The one credential store of every host (the CLI, the desktop app, the
 * VS Code extension and the background service): an owner-only JSON file,
 * `secrets.json` under the storage root. The protection is the file's mode
 * (0600, in a 0700 directory), not keychain encryption, which is what lets a
 * background service read the keys a window saved.
 *
 * Values are persisted through the shared `JsonStore`, with a fail-on-corrupt
 * policy so a corrupt secrets file aborts a write instead of silently wiping
 * every other stored credential.
 *
 * Each operation opens its own `JsonStore` rather than caching one for the
 * lifetime of this instance, so reads (`get`/`listStoredKeys`)
 * always observe the current on-disk file. Mutations take the file's lane in
 * {@link mutationLanes}, claimed in the program's first synchronous step —
 * before the open — so same-key writes preserve caller order. `JsonStore`
 * handles cross-instance and cross-process exclusion while flushing.
 *
 * Waiting for that lane is interruptible, and so is opening the store behind
 * it: a mutation cancelled there has written nothing. The commit itself is
 * not — `JsonStore.set` masks its own read-modify-write once it holds the
 * file's write lane, which is where host-controller study Q2's guarantee
 * lives. Reads are plain programs: this store runs none of its own, so it
 * holds no runtime and outlives any of them.
 *
 * `onChanged` is the host's "re-read this key" signal (`credentialChanged`),
 * told after every write of this process and, through {@link watch}, of
 * every other one.
 */
export class FileSecrets implements PlatformSecrets {
  private readonly filePath: string;
  private readonly onChanged: (key: string) => void;

  constructor(filePath: string, onChanged: (key: string) => void) {
    this.filePath = filePath;
    this.onChanged = onChanged;
  }

  get(key: string): Effect.Effect<string | undefined, SecretsFailed> {
    return Effect.map(this.openStore(), (store) => {
      const value = store.get<unknown>(key, undefined);
      return typeof value === 'string' ? value : undefined;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretsFailed({
            reason: 'io',
            operation: 'get',
            key,
            message: `Could not read the secrets file at ${this.filePath}: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  set(key: string, value: string): Effect.Effect<void, SecretsFailed> {
    return this.mutate('set', key, value);
  }

  delete(key: string): Effect.Effect<void, SecretsFailed> {
    return this.mutate('delete', key, undefined);
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return Effect.map(this.openStore(), (store) => store.keys()).pipe(
      Effect.mapError(
        (cause) =>
          new SecretsFailed({
            reason: 'io',
            operation: 'listStoredKeys',
            message: `Could not read the secrets file at ${this.filePath}: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  /**
   * One mutation of the secrets file. Taking this lane and opening the store
   * are both interruptible; the commit `JsonStore.set` runs behind the file's
   * own write lane is not, so a cancelled caller either never started the
   * commit or observes a finished one. The `credentialChanged` signal runs
   * on every exit, because a commit that
   * landed still exits as interrupted when its caller was cancelled.
   */
  private mutate(
    operation: Extract<SecretsOperation, 'set' | 'delete'>,
    key: string,
    value: string | undefined,
  ) {
    return withPerKeyLane(
      mutationLanes,
      this.filePath,
    )(Effect.flatMap(this.openStore(), (store) => store.set(key, value))).pipe(
      Effect.mapError(
        (cause) =>
          new SecretsFailed({
            reason: 'io',
            operation,
            key,
            message: `Could not ${operation === 'set' ? 'store' : 'remove'} the secret "${key}": ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
      Effect.ensuring(Effect.sync(() => this.onChanged(key))),
    );
  }

  /**
   * Tell `onChanged` about the keys another process's write may have
   * changed, for as long as the caller's fiber runs: every key the file held
   * before or holds after a change. A write is an atomic rename, so the
   * directory is what is watched.
   */
  watch(): Effect.Effect<void, never, FileSystem.FileSystem> {
    const { filePath, onChanged } = this;
    const name = path.basename(filePath);
    // An unreadable file reads as no keys, said once per read.
    const keys = this.listStoredKeys().pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Cannot list the keys in ${filePath}`).pipe(
          Effect.annotateLogs({ data: error }),
          Effect.as<readonly string[]>([]),
        ),
      ),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let known = new Set(yield* keys);
      yield* fs.watch(path.dirname(filePath)).pipe(
        Stream.filter((event) => path.basename(event.path) === name),
        Stream.runForEach(() =>
          Effect.map(keys, (listed) => {
            const now = new Set(listed);
            for (const key of new Set([...known, ...now])) onChanged(key);
            known = now;
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            `Stopped watching ${filePath}: keys saved by another TeXRA window apply after a restart`,
          ).pipe(Effect.annotateLogs({ data: error })),
        ),
      );
    });
  }

  private openStore() {
    return JsonStore.open(this.filePath, { mode: SECRETS_FILE_MODE }).pipe(
      Effect.provide(nodeFileServices),
    );
  }
}

/** The secrets file under a storage root (`~/.texra` in production). */
export function secretsPath(storageRoot: string): string {
  return path.join(storageRoot, 'secrets.json');
}
