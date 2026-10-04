/**
 * The one port the package takes credentials through: a named-secret store.
 * API keys (`apiKey.<provider>`) and the subscription sessions are entries of
 * it. The host serves it from its own store (TeXRA's hosts share one
 * owner-only directory); the package never opens one.
 *
 * A credential that may also come from the environment is read through
 * {@link resolveCredential}, the one secret-then-env ladder. The environment
 * is Effect's ambient `ConfigProvider`, which the host installs.
 */
import { Config, Data, Effect, Option } from 'effect';

/**
 * Why a secret operation failed, as the host stores can actually fail:
 *
 * - `store-unavailable` — the host has no store to write to at all (an
 *   embedder that persists nothing). Only {@link CredentialStore.set} raises
 *   it.
 * - `io` — the backing file or host API failed: a Node errno, a rejected
 *   host call.
 */
type SecretsFailureReason = 'store-unavailable' | 'io';

/** Which member of a store failed. */
export type SecretsOperation = 'get' | 'set' | 'delete' | 'listStoredKeys';

/**
 * The one failure of a credential store. Callers match on `reason` rather
 * than on a message: a surface that wants to distinguish "nothing can be
 * stored here" from "the store is broken" reads the tag, and a caller that
 * wants neither still sees a typed error instead of `unknown`.
 */
export class SecretsFailed extends Data.TaggedError('SecretsFailed')<{
  readonly reason: SecretsFailureReason;
  readonly operation: SecretsOperation;
  readonly message: string;
  readonly key?: string;
  readonly cause?: unknown;
}> {}

/**
 * A store of named secrets. Every member is an `Effect`, so a credential read
 * is interruptible like the program around it and its failure is typed. The
 * host's store owns its write semantics (a commit that survives
 * cancellation, the change signal it publishes).
 */
export interface CredentialStore {
  /** The persisted secret under a name, or `undefined`. */
  get(name: string): Effect.Effect<string | undefined, SecretsFailed>;
  set(name: string, value: string): Effect.Effect<void, SecretsFailed>;
  delete(name: string): Effect.Effect<void, SecretsFailed>;
}

/** Where a resolved credential came from. */
export type CredentialOrigin = 'secret' | 'env' | 'none';

/** One variable of the ambient environment; unset and `''` read as undefined. */
const envVar = (name: string): Effect.Effect<string | undefined> =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
    Effect.orDie,
  );

/**
 * The one credential ladder: the persisted secret under `name`, else the
 * first of `envNames` set in the environment, in order. Both are trimmed and
 * a blank value reads as unset, so an empty variable does not mask anything.
 * The environment comes from the ambient Effect `ConfigProvider`, the live
 * process environment in production; tests replace it through a provider
 * record rather than mutating `process.env`. API keys and the GitHub token
 * both read through here, so the value and the origin a status surface
 * reports can never disagree.
 */
export function resolveCredential(
  store: Pick<CredentialStore, 'get'>,
  name: string,
  envNames: readonly string[],
): Effect.Effect<
  { readonly value: string | undefined; readonly origin: CredentialOrigin },
  SecretsFailed
> {
  return Effect.gen(function* () {
    const stored = (yield* store.get(name))?.trim();
    if (stored) return { value: stored, origin: 'secret' as const };
    for (const envName of envNames) {
      const fromEnv = (yield* envVar(envName))?.trim();
      if (fromEnv) return { value: fromEnv, origin: 'env' as const };
    }
    return { value: undefined, origin: 'none' as const };
  });
}
