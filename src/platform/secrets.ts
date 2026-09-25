/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. VS Code uses context.secrets, the
 * CLI a config file, Electron `safeStorage`. The store answers only what it
 * holds; a credential that may also come from the environment is read through
 * {@link resolveCredential}, the one secret-then-env ladder.
 */
import { Context, Data, Effect, Layer } from 'effect';
import { envVar } from '@utils/system/envFlags';

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
 *   and recovered inside the desktop store's `get`
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
export type SecretsOperation = 'get' | 'set' | 'delete' | 'listStoredKeys';

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
 * Every member is an `Effect`, so a caller inside a program gets
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
 * publish the `credentialChanged` app signal (the VS Code store publishes it
 * from `SecretStorage.onDidChange` instead). A writer does not by hand.
 */
export interface PlatformSecrets {
  /** The persisted secret under a key name, or `undefined`. */
  get(key: string): Effect.Effect<string | undefined, SecretsFailed>;

  /** Store a secret. The commit region is uninterruptible (see above). */
  set(key: string, value: string): Effect.Effect<void, SecretsFailed>;

  /** Delete a secret. The commit region is uninterruptible (see above). */
  delete(key: string): Effect.Effect<void, SecretsFailed>;

  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;
}

/** Where a resolved credential came from. */
export type CredentialOrigin = 'secret' | 'env' | 'none';

/**
 * The one credential ladder: the persisted secret under `storageKey`, else the
 * first of `envNames` set in the environment, in order. Both are trimmed and a
 * blank value reads as unset, so an empty variable does not mask anything.
 * The environment comes from the ambient Effect `ConfigProvider` (`envVar`),
 * the live process environment in production; tests replace it through a
 * provider record rather than mutating `process.env`. API keys and the GitHub
 * token both read through here, so the value and the origin a status surface
 * reports can never disagree.
 */
export function resolveCredential(
  secrets: PlatformSecrets,
  storageKey: string,
  envNames: readonly string[],
): Effect.Effect<
  { readonly value: string | undefined; readonly origin: CredentialOrigin },
  SecretsFailed
> {
  return Effect.gen(function* () {
    const stored = (yield* secrets.get(storageKey))?.trim();
    if (stored) return { value: stored, origin: 'secret' as const };
    for (const name of envNames) {
      const fromEnv = (yield* envVar(name))?.trim();
      if (fromEnv) return { value: fromEnv, origin: 'env' as const };
    }
    return { value: undefined, origin: 'none' as const };
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
