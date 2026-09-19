// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

/** What VS Code hands a progress task to report through. */
type ProgressReporter = vscode.Progress<{
  message?: string;
  increment?: number;
}>;

/**
 * VS Code's `withProgress`, wrapped exactly once for the whole extension:
 * the notification (or view badge) lives for exactly as long as the body,
 * and the body is an Effect rather than a promise.
 *
 * `withProgress` only knows how to wait on a promise, so it is handed one
 * this program resolves when the body settles. The body itself is a step of
 * the calling fiber — not a nested settle on a runtime the caller had to be
 * given — so its services, its interruption and its typed failures are the
 * caller's own. `ensuring` covers every step from the moment the notification
 * opens, so an interrupt landing before the task callback has even run still
 * resolves the promise VS Code is waiting on and the notification cannot
 * outlive the work.
 */
export const withVSCodeProgress = <A, E, R>(
  options: vscode.ProgressOptions,
  body: (
    progress: ProgressReporter,
    token: vscode.CancellationToken,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    let taskSettled!: () => void;
    const bodyDone = new Promise<void>((resolve) => {
      taskSettled = resolve;
    });

    let taskStarted!: (handles: {
      progress: ProgressReporter;
      token: vscode.CancellationToken;
    }) => void;
    const started = new Promise<{
      progress: ProgressReporter;
      token: vscode.CancellationToken;
    }>((resolve) => {
      taskStarted = resolve;
    });

    const dismissed = vscode.window.withProgress(options, (progress, token) => {
      taskStarted({ progress, token });
      return bodyDone;
    });

    return yield* Effect.gen(function* () {
      const { progress, token } = yield* Effect.promise(() => started);
      const exit = yield* Effect.exit(body(progress, token));
      yield* Effect.sync(() => taskSettled());
      yield* Effect.promise(() => dismissed);
      return yield* exit;
    }).pipe(Effect.ensuring(Effect.sync(() => taskSettled())));
  });
