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
 *   Only {@link PlatformSecrets.listStoredKeys} raises it.
 * - `store-unavailable` — the host has no secure store to write to at all
 *   (Electron `safeStorage` unavailable, or Linux `basic_text` backing).
 *   Only {@link PlatformSecrets.set} raises it.
 * - `decrypt-failed` — a stored value exists but the OS refused to decrypt it
 *   (a denied keychain prompt, a rotated key, a corrupt entry). Raised by
 *   `getStored` in the desktop store, which still recovers it to "no saved
 *   secret" itself because that member is Promise-shaped; it reaches callers
 *   when the reads are typed.
 * - `io` — the backing file or host API failed: a Node errno, a corrupt JSON
 *   store, a rejected host call.
 *
 * `get` and `getStored` stay Promise-shaped for now: typing them runs through
 * the model-availability computation, which is its own slice (#12424, lane A
 * finding), not a port change.
 */
type SecretsFailureReason =
  'enumeration-unsupported' | 'store-unavailable' | 'decrypt-failed' | 'io';

/** Which member of the port failed. */
export type SecretsOperation =
  'getStored' | 'set' | 'delete' | 'listStoredKeys';

/**
 * The one failure of the Effect-typed members of {@link PlatformSecrets}.
 * Callers match on `reason` rather than on a message: a credential surface
 * that wants to distinguish "this host cannot list keys" from "the store is
 * broken" reads the tag, and a caller that wants neither still sees a typed
 * error instead of `unknown`.
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
 * The writing members and the key audit are `Effect`s, so a caller inside a
 * program gets the failure typed as {@link SecretsFailed} instead of
 * `unknown`. {@link PlatformSecrets.set} and {@link PlatformSecrets.delete}
 * carry one extra rule, ruled for host-controller study Q2: a credential
 * commit survives cancellation. The uninterruptible region is the commit
 * itself and nothing before it — for the file-backed stores it begins once
 * the write lane has been entered, inside `JsonStore.set`, so a write still
 * queued behind another one can be cancelled; for the VS Code store it is the
 * single `SecretStorage` call, which is the whole commit. Everything that
 * prepares a write — the lane wait, opening the store, the desktop store's
 * encrypt step — stays interruptible, because interruption there means
 * nothing was written. A caller with a post-commit step of its own (dropping
 * a key cache, say) owes it the same guarantee and cannot get it from a step
 * after the write: a commit the store landed still exits as interrupted when
 * its caller was cancelled during it, so the step — and any finalizer that
 * reads the exit — is skipped over a credential that is now on disk. Run it
 * as an `Effect.ensuring` finalizer, which runs on every exit.
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
 * `installProcessRuntime`. The shape is the port itself: a program that
 * writes a credential yields the store's own Effect, and the members that are
 * still Promise-shaped are the reads this port has not typed yet.
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
