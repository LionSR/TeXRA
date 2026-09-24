import { type BrowserWindow, clipboard, dialog } from 'electron';
import { Effect } from 'effect';
import type { SubscriptionDeviceCodePrompt } from '@controllers/modelAccess/subscriptionProviders';
import { ensureError } from '@utils/errors/errorMessage';

/** A synchronous clipboard throw is a typed failure, so it reaches the
 *  presenter's `onError` and the failure dialog instead of skipping both. */
const copyToClipboard = (text: string) =>
  Effect.try({ try: () => clipboard.writeText(text), catch: ensureError });

const showInfoDialog = (
  window: BrowserWindow,
  options: { message: string; detail: string; buttons: [string, string] },
) =>
  Effect.tryPromise({
    try: () =>
      dialog.showMessageBox(window, {
        type: 'info',
        ...options,
        defaultId: 0,
        cancelId: 1,
      }),
    catch: ensureError,
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
      showInfoDialog(window, {
        message: `Signing in with ${productName}`,
        detail:
          `Opened your default browser. Using a different browser for ${productName}? ` +
          'Open this link there instead:\n\n' +
          `${url}`,
        buttons: ['Copy Sign-in Link', 'Close'],
      }).pipe(
        Effect.flatMap((result) =>
          result.response === 0 ? copyToClipboard(url) : Effect.void,
        ),
      ),
    presentSubscriptionDeviceCode: (
      prompt: SubscriptionDeviceCodePrompt,
      productName: string,
    ) =>
      Effect.gen(function* () {
        // Copied up front: the dialog closes on any button.
        yield* copyToClipboard(prompt.userCode);
        const result = yield* showInfoDialog(window, {
          message: `Sign in with ${productName}`,
          detail:
            `No browser could take the sign-in callback, so ${productName} ` +
            'is signing in with a one-time code instead.\n\n' +
            `1. Open ${prompt.verificationUrl}\n` +
            `2. Enter the code: ${prompt.userCode} (copied to the clipboard)\n\n` +
            'TeXRA is waiting for you to approve it.',
          buttons: ['Open Verification Page', 'Close'],
        });
        if (result.response === 0) {
          yield* openExternal(
            prompt.verificationUrlComplete ?? prompt.verificationUrl,
          );
        }
      }),
  };
}
