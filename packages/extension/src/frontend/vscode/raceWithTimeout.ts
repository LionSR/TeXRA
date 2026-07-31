/**
 * VS Code event/timeout racing helper, shared by call sites that wait on a
 * one-shot VS Code event with a timeout fallback.
 */

import * as vscode from 'vscode';

export type Raced<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Race a one-shot event subscription against a timeout. Disposes the
 * subscription and clears the timer in whichever branch wins so we
 * never leak listeners or pending timers.
 */
export function raceWithTimeout<T>(
  subscribe: (resolve: (value: T) => void) => vscode.Disposable,
  timeoutMs: number,
): Promise<Raced<T>> {
  return new Promise((resolve) => {
    // Predeclared with `let` so the `settle` closure can read them
    // even if `subscribe` fires its callback synchronously (would
    // otherwise hit the TDZ for the original `const` bindings).
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let disposable: vscode.Disposable | undefined = undefined;
    const settle = (result: Raced<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      disposable?.dispose();
      resolve(result);
    };
    disposable = subscribe((value) => settle({ timedOut: false, value }));
    if (settled) {
      // `subscribe` already resolved synchronously; settle() ran
      // before `disposable` was assigned, so dispose now and skip
      // the timer entirely.
      disposable.dispose();
      return;
    }
    timer = setTimeout(() => settle({ timedOut: true }), timeoutMs);
  });
}
