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
 *   (a denied keychain prompt, a rotated key, a corrupt entry). It is raised
 *   and recovered inside the desktop store's `getStored`
 *   (`ElectronSecrets.decryptStored`), which answers "no saved secret" after
 *   logging the cause and warning the user once. That recovery is the
 *   documented rule, not a swallow: every reader of a credential wants the
 *   same answer from a value that cannot be decrypted, and failing the
 *   channel instead would take down surfaces that only ask whether a key
 *   exists. The reason stays in this vocabulary because the store constructs
 *   it to report it.
 * - `io` — the backing file or host API failed: a Node errno, a corrupt JSON
 *   store, a rejected host call.
 */
type SecretsFailureReason =
  'enumeration-unsupported' | 'store-unavailable' | 'decrypt-failed' | 'io';

/** Which member of the port failed. */
export type SecretsOperation =
  'get' | 'getStored' | 'set' | 'delete' | 'listStoredKeys';

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
 * Every member but `getEnv` is an `Effect`, so a caller inside a program gets
 * the failure typed as {@link SecretsFailed} instead of `unknown`, and a
 * credential read is interruptible like the program around it.
 * {@link PlatformSecrets.set} and {@link PlatformSecrets.delete}
 * carry one extra rule, ruled for host-controller study Q2: a credential
 * commit survives cancellation. The uninterruptible region is the commit
 * itself and nothing before it — for the file-backed stores it begins once
 * the write lane has been entered, inside `JsonStore.set`, so a write still
 * queued behind another one can be cancelled; for the VS Code store it is the
 * single `SecretStorage` call, which is the whole commit. Everything that
 * prepares a write — the lane wait, opening the store, the desktop store's
 * encrypt step — stays interruptible, because interruption there means
 * nothing was written. A post-commit step cannot run as a step after the
 * write: a commit the store landed still exits as interrupted when its caller
 * was cancelled during it, so the step would be skipped over a credential
 * that is now on disk. The host stores therefore own the post-commit facts
 * themselves, in an `Effect.ensuring` finalizer that runs on every exit: they
 * drop the API-key lookup cache (`invalidateApiKeyCache`) and publish the
 * `credentialChanged` app signal (the VS Code store publishes it from
 * `SecretStorage.onDidChange` instead). A writer does neither by hand.
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
   * and mockable in tests.
   */
  getEnv(name: string): string | undefined;
}

/**
 * Default {@link PlatformSecrets.get} body: an environment-variable override,
 * else the persisted value. Every host implements `get()` this way over its
 * own `getEnv`/`getStored`, so each host's `get()` becomes a one-line
 * `secretsGet(this, key)`. A store read that fails here fails as `get`: the
 * operation names the member the caller invoked, not the one this body
 * delegated to.
 */
export function secretsGet(
  secrets: Pick<PlatformSecrets, 'getEnv' | 'getStored'>,
  key: string,
): Effect.Effect<string | undefined, SecretsFailed> {
  return Effect.suspend(() => {
    const envValue = secrets.getEnv(key);
    if (envValue !== undefined) return Effect.succeed(envValue);
    // `operation` names the member the caller invoked, so the store read this
    // body delegates to is reported as the `get` it serves. Everything the
    // store knows about the failure — reason, key, cause, message — is the
    // store's and travels unchanged.
    return Effect.mapError(
      secrets.getStored(key),
      (failure) =>
        new SecretsFailed({
          reason: failure.reason,
          operation: 'get',
          message: failure.message,
          key: failure.key,
          cause: failure.cause,
        }),
    );
  });
}

/**
 * The process's secret store as an Effect service (`@texra/platform/Secrets`,
 * injection plan §5 row 1), provided once by the composition root through
 * `installProcessRuntime`. The shape is the port itself: a program that reads
 * or writes a credential yields the store's own Effect and matches
 * {@link SecretsFailed}.
 *
 * `layer` takes the store itself. Every root builds its stores before it
 * installs the runtime that serves them, so there is nothing left to defer:
 * the service is the value the root already holds, not a thunk resolved per
 * member call.
 */
export class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra/platform/Secrets',
) {
  static layer(secrets: PlatformSecrets): Layer.Layer<Secrets> {
    return Layer.succeed(Secrets)(secrets);
  }
}
