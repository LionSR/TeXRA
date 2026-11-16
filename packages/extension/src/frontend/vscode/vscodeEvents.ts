/** VS Code events as Effect values: a stream of every report, or a wait on
 *  the first one. */

import { Deferred, Effect, Option, Queue, Stream } from 'effect';
import * as vscode from 'vscode';

/**
 * Every report of `event`, as a stream. VS Code subscribes on the stream's
 * start and the listener is disposed when the stream ends, on every exit.
 */
export function eventStream<T>(event: vscode.Event<T>): Stream.Stream<T> {
  return Stream.callback<T>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => event((value) => Queue.offerUnsafe(queue, value))),
      (listener) => Effect.sync(() => listener.dispose()),
    ),
  );
}

/**
 * Wait for `subscribe` to report a value, or for `timeoutMs` to elapse —
 * `Option.none` is the timeout. Nothing subscribes until the effect runs, so
 * a caller that must not miss an event its own next action triggers forks
 * this with `startImmediately` and joins the fiber afterwards.
 *
 * The subscription is disposed when the wait's scope closes, on every exit;
 * reports after the first are ignored.
 */
export function firstEventOrTimeout<T>(
  subscribe: (report: (value: T) => void) => vscode.Disposable,
  timeoutMs: number,
): Effect.Effect<Option.Option<T>> {
  return Effect.scoped(
    Effect.gen(function* () {
      const first = yield* Deferred.make<T>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          subscribe((value) => {
            Deferred.doneUnsafe(first, Effect.succeed(value));
          }),
        ),
        (subscription) => Effect.sync(() => subscription.dispose()),
      );
      return yield* Deferred.await(first);
    }),
  ).pipe(Effect.timeoutOption(timeoutMs));
}

/**
 * Complete once `token` is cancelled, at once when it already is. The token
 * fires its event only once, at `cancel()`, so a cancel that came before this
 * subscribed shows only on the flag. The listener is disposed on both exits.
 */
export function tokenCancelled(
  token: vscode.CancellationToken,
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (token.isCancellationRequested) {
      resume(Effect.void);
      return;
    }
    const listener = token.onCancellationRequested(() => {
      listener.dispose();
      resume(Effect.void);
    });
    return Effect.sync(() => listener.dispose());
  });
}
