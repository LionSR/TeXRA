import { Cause, Effect, Exit } from 'effect';

import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { Log } from '@logger/logUtils';
import type { SettingsViewOutboundMessage } from '@shared/settingsView/settingsViewMessages';
import { ensureError } from '@utils/errors/errorMessage';
import type { ExtensionContext, Webview } from 'vscode';

/** Host transport and presentation available to settings command programs. */
export interface SettingsHandlerContext {
  readonly channel: string;
  readonly log: Log;
  readonly extensionContext: ExtensionContext;
  withActiveWebview<E, R>(
    fn: (webview: Webview) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R>;
  postMessageToActiveWebview(
    message: SettingsViewOutboundMessage | null | undefined,
  ): Effect.Effect<void, Error>;
}

/**
 * The one foreign edge under this view's transport: VS Code's own
 * `postMessage`, lifted once for every outbound settings message. A panel
 * disposed mid-post rejects it, and that reaches the program as a failure
 * instead of an unhandled rejection. The message is typed as the union the
 * webview validates, not `unknown`, so a builder's Effect passed without
 * `yield*` is a compile error rather than a serialized Effect it drops.
 */
export function postToWebview(
  webview: Webview,
  message: SettingsViewOutboundMessage,
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
    if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt;
    yield* showLoggedErrorMessage(
      ctx.channel,
      errorMessage,
      Cause.squash(outcome.cause),
    );
  });
}
