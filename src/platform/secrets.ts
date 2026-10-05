/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. Every host serves it from one
 * owner-only file (`FileSecrets`). The store answers only what it
 * holds; a credential that may also come from the environment is read through
 * {@link resolveCredential}, the one secret-then-env ladder.
 */
import { Context, type Effect, Layer } from 'effect';
import type { CredentialStore, SecretsFailed } from '@texra-ai/llm';

/**
 * Provider for secure secret storage (API keys, tokens).
 *
 * Every member is an `Effect`, so a caller inside a program gets
 * the failure typed as {@link SecretsFailed} instead of `unknown`, and a
 * credential read is interruptible like the program around it.
 * {@link PlatformSecrets.set} and {@link PlatformSecrets.delete}
 * carry one extra rule, ruled for host-controller study Q2: a credential
 * commit survives cancellation. The uninterruptible region is the commit
 * itself and nothing before it — for the file-backed store it begins once
 * the write lane has been entered, inside `FileSecrets`, so a write still
 * queued behind another one can be cancelled. Everything that
 * prepares a write — the lane wait, opening the store — stays interruptible, because interruption there means
 * nothing was written. A post-commit step cannot run as a step after the
 * write: a commit the store landed still exits as interrupted when its caller
 * was cancelled during it, so the step would be skipped over a credential
 * that is now on disk. The host stores therefore own the post-commit facts
 * themselves, in an `Effect.ensuring` finalizer that runs on every exit: they
 * publish the `credentialChanged` app signal (the VS Code store publishes it
 * from `SecretStorage.onDidChange` instead). A writer does not by hand.
 */
export interface PlatformSecrets extends CredentialStore {
  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;
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
