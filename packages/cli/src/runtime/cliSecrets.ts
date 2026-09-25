// Node imports
import path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { emitAppSignal } from '@eventBus/AppSignals';
import { invalidateApiKeyCache } from '@model/apiProviders';
import {
  SecretsFailed,
  secretsGet,
  type PlatformSecrets,
  type SecretsOperation,
} from '@platform/secrets';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
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
 * CLI secret storage.
 *
 * Environment variables remain the highest-priority source so automation can
 * keep using ephemeral keys. Values written by CLI login are persisted under
 * the user's TeXRA state directory through the shared `JsonStore` (the same
 * owner `ElectronSecrets` wraps for the desktop host), with a fail-on-corrupt
 * policy so a corrupt secrets file aborts a write instead of silently wiping
 * every other stored credential.
 *
 * Each operation opens its own `JsonStore` rather than caching one for the
 * lifetime of this instance, so reads (`get`/`getStored`/`listStoredKeys`)
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
 */
export class CliSecrets implements PlatformSecrets {
  constructor(private readonly filePath = cliSecretsPath()) {}

  get(key: string) {
    return secretsGet(this, key);
  }

  getStored(key: string) {
    return Effect.map(this.openStore(), (store) => {
      const value = store.get<unknown>(key, undefined);
      return typeof value === 'string' ? value : undefined;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretsFailed({
            reason: 'io',
            operation: 'getStored',
            key,
            message: `Could not read the CLI secrets file at ${this.filePath}: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  set(key: string, value: string) {
    return this.mutate('set', key, value);
  }

  delete(key: string) {
    return this.mutate('delete', key, undefined);
  }

  listStoredKeys() {
    return Effect.map(this.openStore(), (store) => store.keys()).pipe(
      Effect.mapError(
        (cause) =>
          new SecretsFailed({
            reason: 'io',
            operation: 'listStoredKeys',
            message: `Could not read the CLI secrets file at ${this.filePath}: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  /**
   * One mutation of the secrets file. Taking this lane and opening the store
   * are both interruptible; the commit `JsonStore.set` runs behind the file's
   * own write lane is not, so a cancelled caller either never started the
   * commit or observes a finished one. The key cache drop and the
   * `credentialChanged` signal run on every exit, because a commit that
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
            message: `Could not ${operation === 'set' ? 'store' : 'remove'} the CLI secret "${key}": ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          invalidateApiKeyCache();
          emitAppSignal('credentialChanged', { key });
        }),
      ),
    );
  }

  private openStore() {
    return JsonStore.open(this.filePath, { mode: SECRETS_FILE_MODE }).pipe(
      Effect.provide(nodeFileServices),
    );
  }
}

export function cliSecretsPath(
  storageRoot = DEFAULT_NODE_STORAGE_ROOT,
): string {
  return path.join(storageRoot, 'secrets.json');
}

let cliSecrets: CliSecrets | undefined;

/**
 * The one secret store of this process, over the storage root the first
 * caller names: a later caller that names another root, or none, gets that
 * same store rather than a second view over a different file. Nothing here
 * is bound to a process runtime, so a runtime that replaced a disposed one
 * (an init retried after its failure disposed the first) keeps this store.
 */
export function getCliSecrets(storageRoot?: string): CliSecrets {
  cliSecrets ??= new CliSecrets(cliSecretsPath(storageRoot));
  return cliSecrets;
}
