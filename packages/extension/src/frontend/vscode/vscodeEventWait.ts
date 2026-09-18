/**
 * Effect-shaped waits on a one-shot VS Code event.
 *
 * The promise-shaped twin, `raceWithTimeout`, remains for the one caller that
 * has to hand a promise back (`VscodeDiffViewHost.revealFirstChange`, whose
 * `DiffViewHost` port is still Promise-typed).
 */

import { Effect, Option } from 'effect';
import * as vscode from 'vscode';

/**
 * Wait for `subscribe` to report a value, or for `timeoutMs` to elapse —
 * `Option.none` is the timeout. Nothing subscribes until the effect runs, so
 * a caller that must not miss an event its own next action triggers forks
 * this with `startImmediately` and joins the fiber afterwards.
 *
 * The subscription is disposed on every exit: Effect runs the finalizer only
 * when the wait is interrupted (the timeout, or the whole program), so the
 * event that resumes normally unsubscribes itself, and `dispose` drops the
 * subscription it disposed so both paths can run. A `subscribe` that reports
 * synchronously settles before the disposable exists, which the second
 * `dispose` covers.
 */
export function firstEventOrTimeout<T>(
  subscribe: (report: (value: T) => void) => vscode.Disposable,
  timeoutMs: number,
): Effect.Effect<Option.Option<T>> {
  return Effect.callback<T>((resume) => {
    let settled = false;
    let subscription: vscode.Disposable | undefined;
    const dispose = () => {
      subscription?.dispose();
      subscription = undefined;
    };
    subscription = subscribe((value) => {
      settled = true;
      dispose();
      resume(Effect.succeed(value));
    });
    if (settled) dispose();
    return Effect.sync(dispose);
  }).pipe(Effect.timeoutOption(timeoutMs));
}
