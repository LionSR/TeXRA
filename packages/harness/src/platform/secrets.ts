/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. Every host serves it from one
 * owner-only file (`FileSecrets`). The store answers only what it
 * holds; a credential that may also come from the environment is read through
 * {@link resolveCredential}, the one secret-then-env ladder.
 */
import { Context, Effect, Layer } from 'effect';
import { AppSignals } from '@platform/appSignals';
import type { CredentialStore, SecretsFailed } from '@texra-ai/llm';

/**
 * Provider for secure secret storage (API keys, tokens).
 *
 * Every member is an `Effect`, so a caller inside a program gets
 * the failure typed as {@link SecretsFailed} instead of `unknown`, and a
 * credential read is interruptible like the program around it.
 * {@link PlatformSecrets.set} and {@link PlatformSecrets.delete}
 * carry one extra rule: a credential
 * commit survives cancellation. The uninterruptible region is the commit
 * itself and nothing before it — for the file-backed store it begins once
 * the write lane has been entered, inside `FileSecrets`, so a write still
 * queued behind another one can be cancelled. Everything that
 * prepares a write — the lane wait, opening the store — stays interruptible, because interruption there means
 * nothing was written. A post-commit step cannot run as a step after the
 * write: a commit the store landed still exits as interrupted when its caller
 * was cancelled during it, so the step would be skipped over a credential
 * that is now on disk. The host stores therefore own the post-commit facts
 * themselves, in an `Effect.ensuring` finalizer that runs on every exit: the
 * file store tells the `credentialChanged` app signal its layer hands it
 * (`Secrets.announcing`). A writer does not by hand.
 */
export interface PlatformSecrets extends CredentialStore {
  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;
}

/**
 * The process's secret store as an Effect service, provided once by the composition root through
 * `processLayer`. The shape is the port itself: a program that reads
 * or writes a credential yields the store's own Effect and matches
 * {@link SecretsFailed}.
 *
 * `layer` takes a store built before the runtime (an embedder's, a test's):
 * the service is that value, not a thunk resolved per member call.
 */
export class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra-ai/harness/platform/Secrets',
) {
  static layer(secrets: PlatformSecrets): Layer.Layer<Secrets> {
    return Layer.succeed(Secrets)(secrets);
  }

  /**
   * A host's store, built by the runtime over the process's signal hub:
   * `make` is handed the announcement (`credentialChanged`) to tell after
   * each write it commits. The host reads the store back from context.
   */
  static announcing(
    make: (announce: (key: string) => void) => PlatformSecrets,
  ): Layer.Layer<Secrets, never, AppSignals> {
    return Layer.effect(
      Secrets,
      Effect.map(AppSignals, (signals) =>
        make((key) => signals.emit('credentialChanged', { key })),
      ),
    );
  }
}
