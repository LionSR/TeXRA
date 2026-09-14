// Node imports
import path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
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

// Local file imports
import { cliEnvValue } from './cliContext';

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
 * Nothing here runs a program: `PlatformSecrets` is Effect-typed, so this
 * store is a value the composition root can build before it installs the
 * process runtime, and every call is a step of the caller's own fiber.
 */
export class CliSecrets implements PlatformSecrets {
  constructor(private readonly filePath = cliSecretsPath()) {}

  get(key: string) {
    return secretsGet(this, key);
  }

  getStored(key: string) {
    return Effect.map(this.openStore('getStored', key), (store) => {
      const value = store.get<unknown>(key, undefined);
      return typeof value === 'string' ? value : undefined;
    });
  }

  /** Uninterruptible commit region: see `PlatformSecrets` (study Q2). */
  set(key: string, value: string) {
    return this.mutate(key, value);
  }

  /** Uninterruptible commit region: see `PlatformSecrets` (study Q2). */
  delete(key: string) {
    return this.mutate(key, undefined);
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return Effect.map(this.openStore('listStoredKeys'), (store) =>
      store.keys(),
    );
  }

  getEnv(name: string): string | undefined {
    return cliEnvValue(name);
  }

  /**
   * Waiting for the file's lane stays interruptible; the open-and-flush that
   * follows does not, so a cancelled caller either never wrote or wrote
   * completely (study Q2).
   */
  private mutate(
    key: string,
    value: string | undefined,
  ): Effect.Effect<void, SecretsFailed> {
    const operation: SecretsOperation = value === undefined ? 'delete' : 'set';
    return withPerKeyLane(
      mutationLanes,
      this.filePath,
    )(
      Effect.uninterruptible(
        Effect.flatMap(this.openStore(operation, key), (store) =>
          store
            .update(key, value)
            .pipe(
              Effect.mapError((cause) => this.failed(operation, cause, key)),
            ),
        ),
      ),
    );
  }

  private openStore(operation: SecretsOperation, key?: string) {
    return JsonStore.open(this.filePath, { mode: SECRETS_FILE_MODE }).pipe(
      Effect.mapError((cause) => this.failed(operation, cause, key)),
      Effect.provide(nodeFileServices),
    );
  }

  private failed(
    operation: SecretsOperation,
    cause: unknown,
    key?: string,
  ): SecretsFailed {
    return new SecretsFailed({
      reason: 'io',
      operation,
      key,
      message: `The CLI secret store at ${this.filePath} failed to ${operation}${key ? ` "${key}"` : ''}: ${toErrorMessage(cause)}`,
      cause,
    });
  }
}

export function cliSecretsPath(
  storageRoot = DEFAULT_NODE_STORAGE_ROOT,
): string {
  return path.join(storageRoot, 'secrets.json');
}

let cliSecrets: CliSecrets | undefined;

/**
 * The one secret store of this process. Held rather than rebuilt because
 * callers key per-store caches on its identity (the API-key lookup cache,
 * the subscription session coordinators); the first caller's storage root
 * fixes the file, as it did when the store followed the process runtime.
 */
export function getCliSecrets(storageRoot?: string): CliSecrets {
  cliSecrets ??= new CliSecrets(cliSecretsPath(storageRoot));
  return cliSecrets;
}
