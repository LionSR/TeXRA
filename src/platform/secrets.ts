/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. VS Code uses context.secrets +
 * process.env fallback. CLI/Electron uses process.env + config file.
 */
import { Context, Data, Effect, Layer } from 'effect';

/**
 * Why a secret operation failed, as the host implementations can actually
 * fail today:
 *
 * - `enumeration-unsupported` — the host's store cannot list its key names
 *   (VS Code's `SecretStorage.keys()` on a host that does not implement it).
 *   Only `listStoredKeys` raises it.
 * - `store-unavailable` — the host has no secure store to write to at all
 *   (Electron `safeStorage` unavailable, or Linux `basic_text` backing).
 * - `decrypt-failed` — a stored value exists but the OS refused to decrypt it
 *   (a denied keychain prompt, a rotated key, a corrupt entry).
 * - `io` — the backing file or host API failed: a Node errno, a corrupt JSON
 *   store, a rejected host call.
 */
export type SecretsFailureReason =
  'enumeration-unsupported' | 'store-unavailable' | 'decrypt-failed' | 'io';

/** Which member of the port failed. `get` fails only through `getStored`. */
export type SecretsOperation =
  'getStored' | 'set' | 'delete' | 'listStoredKeys';

/**
 * The one failure of {@link PlatformSecrets}. Callers match on `reason`
 * rather than on a message: a credential surface that wants to distinguish
 * "this host cannot list keys" from "the store is broken" reads the tag, and
 * a caller that wants neither still sees a typed error instead of `unknown`.
 */
export class SecretsFailed extends Data.TaggedError('SecretsFailed')<{
  readonly reason: SecretsFailureReason;
  readonly operation: SecretsOperation;
  readonly message: string;
  readonly key?: string;
  readonly cause?: unknown;
}> {}

/**
 * Provider for secure secret storage (API keys, tokens).
 *
 * Every member is an `Effect`, so a caller inside a program gets the failure
 * typed as {@link SecretsFailed} and the read is interruptible like any other
 * step. {@link set} and {@link delete} are the exception, and deliberately so:
 * host-controller study Q2 was ruled "a credential commit survives
 * cancellation", so each implementation runs its commit region under
 * `Effect.uninterruptible` — interruption is honoured before the commit
 * starts and observed after it lands, never in the middle of a write.
 */
export interface PlatformSecrets {
  /** Get a raw secret by key name. */
  get(key: string): Effect.Effect<string | undefined, SecretsFailed>;

  /**
   * Get a persisted secret without applying environment-variable overrides.
   * This lets credential-management code distinguish a stored key from an
   * equally named key supplied by the process environment.
   */
  getStored(key: string): Effect.Effect<string | undefined, SecretsFailed>;

  /** Store a secret. The commit region is uninterruptible (see above). */
  set(key: string, value: string): Effect.Effect<void, SecretsFailed>;

  /** Delete a secret. The commit region is uninterruptible (see above). */
  delete(key: string): Effect.Effect<void, SecretsFailed>;

  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;

  /**
   * Read a conventional environment variable (e.g. `ANTHROPIC_API_KEY`).
   * Distinct from `get()`, which is keyed by the internal secret-storage
   * name (e.g. `apiKey.anthropic`) and already applies its own env override
   * for that name. Callers that fall back to a differently-named
   * conventional env var (see `apiKeyEnvName`) go through this seam instead
   * of reading `process.env` directly, so the fallback stays host-agnostic
   * and mockable in tests. Synchronous and infallible: it reads the process
   * environment this host already holds.
   */
  getEnv(name: string): string | undefined;
}

/**
 * Default {@link PlatformSecrets.get} body: an environment-variable override,
 * else the persisted value. Every host implements `get()` this way over its
 * own `getEnv`/`getStored`, so each host's `get()` becomes a one-line
 * `secretsGet(this, key)`.
 */
export function secretsGet(
  secrets: Pick<PlatformSecrets, 'getEnv' | 'getStored'>,
  key: string,
): Effect.Effect<string | undefined, SecretsFailed> {
  const envValue = secrets.getEnv(key);
  return envValue === undefined
    ? secrets.getStored(key)
    : Effect.succeed(envValue);
}

/**
 * The process's secret store as an Effect service (`@texra/platform/Secrets`,
 * injection plan §5 row 1), provided once by the composition root through
 * `installProcessRuntime`. The shape is the port itself, and the port is
 * Effect-typed, so the service is the store: nothing stands between a
 * `yield* Secrets` and the host's own program.
 *
 * `layer` takes the store's open program rather than the store, because a
 * `ManagedRuntime` builds its layer at its first run and in the desktop and
 * CLI roots that first run is what opens the store. Opening it here is the
 * layer's own build step, so the store exists exactly once per runtime and
 * no caller resolves anything per member call.
 */
export class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra/platform/Secrets',
) {
  static layer<R>(
    open: Effect.Effect<PlatformSecrets, never, R>,
  ): Layer.Layer<Secrets, never, R> {
    return Layer.effect(Secrets)(open);
  }
}
