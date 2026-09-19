// Third-party imports
import { Context, Effect } from 'effect';
import * as vscode from 'vscode';

/** What VS Code hands a progress task to report through. */
export type ProgressReporter = vscode.Progress<{
  message?: string;
  increment?: number;
}>;

/**
 * VS Code's `withProgress`, wrapped exactly once for the whole extension:
 * the notification (or view badge) lives for exactly as long as the task,
 * and the task is an Effect rather than a promise.
 *
 * The body runs on the calling fiber's own services — taken with
 * {@link Effect.contextWith} and handed straight back to the run inside the
 * callback — so a command no longer carries a `ProcessRuntime` just to settle
 * its progress body, and nothing inside a progress notification is a second
 * boundary. Failures come back as the body's own typed error: the inner run
 * returns an `Exit`, which is itself an Effect, so it is re-raised into the
 * caller unchanged. A rejection from `withProgress` itself can therefore only
 * be a host defect, and stays one.
 */
export const withVSCodeProgress = <A, E, R>(
  options: vscode.ProgressOptions,
  body: (
    progress: ProgressReporter,
    token: vscode.CancellationToken,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.contextWith((context: Context.Context<R>) =>
    Effect.flatMap(
      Effect.promise(() =>
        vscode.window.withProgress(options, (progress, token) =>
          Effect.runPromiseExitWith(context)(body(progress, token)),
        ),
      ),
      (exit) => exit,
    ),
  );
