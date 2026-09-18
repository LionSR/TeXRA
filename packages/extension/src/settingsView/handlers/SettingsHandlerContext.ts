import { Cause, Effect, Exit } from 'effect';

import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { Log } from '@logger/logUtils';
import { ensureError } from '@utils/errors/errorMessage';
import type { ExtensionContext, Webview } from 'vscode';

/**
 * The slice-visible face of `SettingsViewMessageHandler`: the channel and log
 * it reports through, the VS Code extension context, and the two transport
 * accessors inbound command slices and handler delegates share.
 *
 * Both are programs, not promises. `vscode.Webview.postMessage` is the one
 * foreign edge behind them and it is wrapped by {@link postToWebview} below;
 * everything above it — the `send*` builders, the refresh fan-outs, the
 * delegates' handlers — composes as `Effect` and is settled once per inbound
 * message arm at the dispatcher, which is this host's entry.
 *
 * Ordering is unchanged: a post still completes before a mutation follow-up
 * runs (a settings refresh after a write; hide-banner then credential
 * refresh), because the program sequences them.
 *
 * `withActiveWebview` is the shared "run with the active webview" accessor
 * (`vscode.Webview`). View-wrapper access (`vscode.WebviewView`) stays
 * view-specific.
 */
export interface SettingsHandlerContext {
  readonly channel: string;
  readonly log: Log;
  readonly extensionContext: ExtensionContext;
  withActiveWebview<E, R>(
    fn: (webview: Webview) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R>;
  postMessageToActiveWebview(message: unknown): Effect.Effect<void, Error>;
}

/**
 * The one foreign edge under this view's transport: VS Code's own
 * `postMessage`, lifted once for every outbound settings message. A panel
 * disposed mid-post rejects it, and that reaches the program as a failure
 * instead of an unhandled rejection. Only the goal list lifts `postMessage`
 * itself, because it reads the delivered flag this discards.
 */
export function postToWebview(
  webview: Webview,
  message: unknown,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await webview.postMessage(message);
    },
    catch: ensureError,
  });
}

/**
 * Run `program`, logging and surfacing any failure as a settings-view error
 * message instead of letting it propagate. Shared by every handler delegate
 * to avoid re-typing the same report around each message handler.
 *
 * `Effect.exit` absorbs an interruption exactly as it absorbs a failure, so
 * the exit is checked for interrupts and re-raised instead: what interrupts
 * these fibers is the process runtime being disposed, and the view an error
 * dialog would talk about is going away with it.
 */
export function withHandlerErrorHandling<E, R>(
  ctx: SettingsHandlerContext,
  errorMessage: string,
  program: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R> {
  return Effect.gen(function* () {
    const outcome = yield* Effect.exit(program);
    if (Exit.isSuccess(outcome)) return;
    if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.interrupt;
    yield* Effect.promise(() =>
      showLoggedErrorMessage(
        ctx.channel,
        errorMessage,
        Cause.squash(outcome.cause),
      ),
    );
  });
}

/**
 * `Promise.all` semantics for a fan-out of refresh programs: every program
 * runs to completion even when one of them fails, and the first failure is
 * the result. `Effect.all` alone would interrupt the siblings of a failed
 * program — the awaited `Promise.all` these replace let them finish, and a
 * half-repainted settings view is not an improvement.
 */
export function allSettledVoid<E, R>(
  programs: readonly Effect.Effect<void, E, R>[],
): Effect.Effect<void, E, R> {
  return Effect.flatMap(
    Effect.all(programs.map(Effect.exit), { concurrency: 'unbounded' }),
    (exits) => {
      const failed = exits.find(Exit.isFailure);
      return failed ? Effect.failCause(failed.cause) : Effect.void;
    },
  );
}
