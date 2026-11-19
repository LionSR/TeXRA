import { type BrowserWindow, clipboard } from 'electron';
import { Effect } from 'effect';
import type { SubscriptionDeviceCodePrompt } from '@texra-ai/llm/node';
import { hostFailed } from '@texra/controllers/session/hostCallFailure';
import type { SubscriptionProvider } from '@texra/controllers/modelAccess/subscriptionProviders';
import { SIGN_IN_PROMPT } from '@ui/copy/accountAuth';
import { choose } from './desktopDialogs.js';

/** What the dialogs name: the provider and its browser session's account. */
type SignInNames = Pick<SubscriptionProvider, 'displayName' | 'sessionName'>;

/** A synchronous clipboard throw is a typed failure. Copying the sign-in
 *  link lets it reach the presenter's `onError` and the failure dialog; the
 *  device-code dialog logs it and still shows the code. */
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
    presentSubscriptionSignInUrl: (url: string, names: SignInNames) =>
      choose(window, {
        type: 'info',
        message: `Signing in with ${names.displayName}`,
        detail: `Opened your default browser. ${SIGN_IN_PROMPT.otherBrowser(names.sessionName)}\n\n${url}`,
        choices: [{ label: 'Copy Sign-in Link', value: url, default: true }],
        close: 'Close',
      }).pipe(
        Effect.flatMap((copy) => (copy ? copyToClipboard(copy) : Effect.void)),
      ),
    presentSubscriptionDeviceCode: Effect.fn('presentSubscriptionDeviceCode')(
      function* (prompt: SubscriptionDeviceCodePrompt, names: SignInNames) {
        const { displayName } = names;
        // Copied up front: the dialog closes on any button. A failed copy
        // still shows the code, which the dialog then does not call copied.
        const copied = yield* copyToClipboard(prompt.userCode).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not copy the ${displayName} sign-in code: ${error.message}`,
            ).pipe(Effect.as(false)),
          ),
        );
        const verificationUrl = yield* choose(window, {
          type: 'info',
          message: `Sign in with ${displayName}`,
          detail:
            `No browser could take the sign-in callback, so ${displayName} ` +
            'is signing in with a one-time code instead.\n\n' +
            `${SIGN_IN_PROMPT.deviceCodeSteps(displayName, prompt, copied)}\n\n` +
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
