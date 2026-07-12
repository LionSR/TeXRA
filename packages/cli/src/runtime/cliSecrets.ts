// Standard library imports
import path from 'node:path';

// Local imports - platform
import { JsonStore } from '@platform/defaults/jsonStore';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';

// Local imports - CLI runtime
import { cliEnvValue } from './cliContext';

// Type imports - platform
import type { PlatformSecrets } from '@platform/secrets';

/** Secrets file is owner-only: `0o600` (containing dir gets `0o700`). */
const SECRETS_FILE_MODE = 0o600;

/**
 * CLI secret storage.
 *
 * Environment variables remain the highest-priority source so automation can
 * keep using ephemeral keys. Values written by CLI login are persisted under
 * the user's TeXRA state directory through the shared `JsonStore` (the same
 * owner `ElectronSecrets` wraps for the desktop host), with `strict: true`
 * so a corrupt secrets file aborts a write instead of silently wiping every
 * other stored credential (see `JsonStoreOptions.strict`).
 *
 * Each operation opens its own `JsonStore` rather than caching one for the
 * lifetime of this instance: separate `texra` invocations are separate
 * processes, and a fresh open re-reads the file so a concurrently running
 * CLI invocation's write isn't clobbered by a stale in-memory snapshot.
 *
 * `set()`/`delete()` are additionally serialized through {@link mutationQueue}
 * so overlapping mutations *within this process* don't each open a store off
 * the same on-disk snapshot and flush independently — the later flush would
 * otherwise silently drop the key the earlier one just wrote. Reads
 * (`get`/`getStored`/`listStoredKeys`) stay outside the queue and always open
 * a fresh store, matching prior `readSecrets()` behavior.
 */
export class CliSecrets implements PlatformSecrets {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = cliSecretsPath()) {}

  async get(key: string): Promise<string | undefined> {
    return cliEnvValue(key) ?? (await this.getStored(key));
  }

  async getStored(key: string): Promise<string | undefined> {
    const store = await this.openStore();
    const value = store.get<unknown>(key, undefined);
    return typeof value === 'string' ? value : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.mutate((store) => store.set(key, value));
  }

  async delete(key: string): Promise<void> {
    await this.mutate((store) => store.set(key, undefined));
  }

  async listStoredKeys(): Promise<readonly string[]> {
    const store = await this.openStore();
    return Object.keys(store.snapshot());
  }

  getEnv(name: string): string | undefined {
    return cliEnvValue(name);
  }

  /**
   * Runs `op` against a freshly opened store, chained after any mutation
   * already queued on this instance so overlapping `set()`/`delete()` calls
   * serialize instead of racing. The chain link is established synchronously
   * (before the first `await`), so ordering is captured at call time, not at
   * whatever point `openStore()`'s `mkdir`/read happens to settle.
   */
  private mutate(op: (store: JsonStore) => Promise<void>): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const store = await this.openStore();
      await op(store);
    });
    this.mutationQueue = mutation.catch(() => {});
    return mutation;
  }

  private openStore(): Promise<JsonStore> {
    return JsonStore.open(this.filePath, {
      mode: SECRETS_FILE_MODE,
      strict: true,
    });
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
