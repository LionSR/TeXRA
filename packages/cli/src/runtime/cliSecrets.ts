// Node imports
import path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { secretWithEnvOverride, type PlatformSecrets } from '@platform/secrets';
import { effectRuntime } from '@platform/processRuntime';
import { JsonStore } from '@platform/defaults/jsonStore';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

// Local file imports
import { cliEnvValue } from './cliContext';

/** Secrets file is owner-only: `0o600` (containing dir gets `0o700`). */
const SECRETS_FILE_MODE = 0o600;

/**
 * One mutation lane per secrets file, so two instances over the same path
 * still write in call order before entering the cross-process lock.
 */
const mutationLanes = new Map<string, PerKeyLane>();

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
 * `PlatformSecrets` is a Promise-shaped platform port, so this host
 * implementation is where its programs are run; every line of logic above
 * that boundary is an `Effect`.
 */
export class CliSecrets implements PlatformSecrets {
  constructor(private readonly filePath = cliSecretsPath()) {}

  get(key: string): Promise<string | undefined> {
    return secretWithEnvOverride(key, cliEnvValue, (k) => this.getStored(k));
  }

  getStored(key: string): Promise<string | undefined> {
    return effectRuntime().runPromise(
      Effect.map(this.openStore(), (store) => {
        const value = store.get<unknown>(key, undefined);
        return typeof value === 'string' ? value : undefined;
      }),
    );
  }

  set(key: string, value: string): Promise<void> {
    return this.mutate(key, value);
  }

  delete(key: string): Promise<void> {
    return this.mutate(key, undefined);
  }

  listStoredKeys(): Promise<readonly string[]> {
    return effectRuntime().runPromise(
      Effect.map(this.openStore(), (store) => store.keys()),
    );
  }

  getEnv(name: string): string | undefined {
    return cliEnvValue(name);
  }

  private mutate(key: string, value: string | undefined): Promise<void> {
    return effectRuntime().runPromise(
      withPerKeyLane(
        mutationLanes,
        this.filePath,
      )(Effect.flatMap(this.openStore(), (store) => store.set(key, value))),
    );
  }

  private openStore() {
    return JsonStore.open(this.filePath, { mode: SECRETS_FILE_MODE });
  }
}

export function cliSecretsPath(
  storageRoot = DEFAULT_NODE_STORAGE_ROOT,
): string {
  return path.join(storageRoot, 'secrets.json');
}

let cliSecrets: CliSecrets | undefined;

export function getCliSecrets(storageRoot?: string): CliSecrets {
  cliSecrets ??= new CliSecrets(cliSecretsPath(storageRoot));
  return cliSecrets;
}
