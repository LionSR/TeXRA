/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. VS Code uses context.secrets +
 * process.env fallback. CLI/Electron uses process.env + config file.
 */
import { Context, Layer } from 'effect';

/**
 * Provider for secure secret storage (API keys, tokens).
 */
export interface PlatformSecrets {
  /** Get a raw secret by key name. */
  get(key: string): Promise<string | undefined>;

  /**
   * Get a persisted secret without applying environment-variable overrides.
   * This lets credential-management code distinguish a stored key from an
   * equally named key supplied by the process environment.
   */
  getStored(key: string): Promise<string | undefined>;

  /** Store a secret. */
  set(key: string, value: string): Promise<void>;

  /** Delete a secret. */
  delete(key: string): Promise<void>;

  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Promise<readonly string[]>;

  /**
   * Read a conventional environment variable (e.g. `ANTHROPIC_API_KEY`).
   * Distinct from `get()`, which is keyed by the internal secret-storage
   * name (e.g. `apiKey.anthropic`) and already applies its own env override
   * for that name. Callers that fall back to a differently-named
   * conventional env var (see `apiKeyEnvName`) go through this seam instead
   * of reading `process.env` directly, so the fallback stays host-agnostic
   * and mockable in tests.
   */
  getEnv(name: string): string | undefined;
}

/**
 * Default {@link PlatformSecrets.get} body: an environment-variable override,
 * else the persisted value. Every host implements `get()` this way over its
 * own `getEnv`/`getStored`, so each host's `get()` becomes a one-line
 * `secretsGet(this, key)`.
 */
export async function secretsGet(
  secrets: Pick<PlatformSecrets, 'getEnv' | 'getStored'>,
  key: string,
): Promise<string | undefined> {
  const envValue = secrets.getEnv(key);
  return envValue !== undefined ? envValue : secrets.getStored(key);
}

/**
 * The process's secret store as an Effect service (`@texra/platform/Secrets`,
 * injection plan §5 row 1), provided once by the composition root through
 * `installProcessRuntime`. The shape is the port itself: a reader that is
 * already an Effect wraps one call in `hostPort` where it did before, and
 * Effect-typing the port is a later step.
 *
 * `layer` takes the store as a thunk because a `ManagedRuntime` builds its
 * whole layer at its first run, and in the desktop and CLI roots that first
 * run is the program that opens this very store. The service resolves the
 * thunk on each member call, by which time every root has finished wiring;
 * the thunk closes over the root's own local, never over `platform()`, and a
 * call before the store exists throws on the calling fiber, never a default.
 */
export class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra/platform/Secrets',
) {
  static layer(secrets: () => PlatformSecrets): Layer.Layer<Secrets> {
    return Layer.succeed(Secrets)({
      get: (key) => secrets().get(key),
      getStored: (key) => secrets().getStored(key),
      set: (key, value) => secrets().set(key, value),
      delete: (key) => secrets().delete(key),
      listStoredKeys: () => secrets().listStoredKeys(),
      getEnv: (name) => secrets().getEnv(name),
    });
  }
}
