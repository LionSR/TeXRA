import { type BrowserWindow, clipboard } from 'electron';
import { Effect } from 'effect';
import type { SubscriptionDeviceCodePrompt } from '@texra-ai/llm/node';
import { hostFailed } from '@texra/controllers/session/hostCallFailure';
import { choose } from './desktopDialogs.js';

/** A synchronous clipboard throw is a typed failure, so it reaches the
 *  presenter's `onError` and the failure dialog instead of skipping both. */
const copyToClipboard = (text: string) =>
  Effect.try({
    try: () => clipboard.writeText(text),
    catch: (cause) => hostFailed('clipboard.writeText', cause),
  });

/**
 * The window's subscription sign-in dialogs: the "sign in in your other
 * browser" link after a loopback launch, and the one-time code for the
 * device-code fallback when no browser can take the callback.
 */
export function desktopSignInPresenters(
  window: BrowserWindow,
  openExternal: (url: string) => Effect.Effect<void, Error>,
) {
  return {
    presentSubscriptionSignInUrl: (url: string, productName: string) =>
      choose(window, {
        type: 'info',
        message: `Signing in with ${productName}`,
        detail:
          `Opened your default browser. Using a different browser for ${productName}? ` +
          'Open this link there instead:\n\n' +
          `${url}`,
        choices: [{ label: 'Copy Sign-in Link', value: url, default: true }],
        close: 'Close',
      }).pipe(
        Effect.flatMap((copy) => (copy ? copyToClipboard(copy) : Effect.void)),
      ),
    presentSubscriptionDeviceCode: Effect.fn('presentSubscriptionDeviceCode')(
      function* (prompt: SubscriptionDeviceCodePrompt, productName: string) {
        // Copied up front: the dialog closes on any button.
        yield* copyToClipboard(prompt.userCode);
        const verificationUrl = yield* choose(window, {
          type: 'info',
          message: `Sign in with ${productName}`,
          detail:
            `No browser could take the sign-in callback, so ${productName} ` +
            'is signing in with a one-time code instead.\n\n' +
            `1. Open ${prompt.verificationUrl}\n` +
            `2. Enter the code: ${prompt.userCode} (copied to the clipboard)\n\n` +
            'TeXRA is waiting for you to approve it.',
          choices: [
            {
              label: 'Open Verification Page',
              value: prompt.verificationUrlComplete ?? prompt.verificationUrl,
              default: true,
            },
          ],
          close: 'Close',
        });
        if (verificationUrl) yield* openExternal(verificationUrl);
      },
    ),
  };
}
