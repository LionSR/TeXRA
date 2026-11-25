import { type BrowserWindow, clipboard } from 'electron';
import { Effect } from 'effect';
import type { SubscriptionDeviceCodePrompt } from '@texra-ai/llm/node';
import { fromHostSync } from '@texra/controllers/session/hostCallFailure';
import type { SubscriptionProvider } from '@texra/controllers/modelAccess/subscriptionProviders';
import { SIGN_IN_PROMPT, SUBSCRIPTION_AUTH_COPY } from '@ui/copy/accountAuth';
import { choose } from './desktopDialogs.js';

/** What the dialogs name: the provider and its browser session's account. */
type SignInNames = Pick<
  SubscriptionProvider,
  'id' | 'displayName' | 'sessionName'
>;

/** A synchronous clipboard throw is a typed failure. Copying the sign-in
 *  link lets it reach the presenter's `onError` and the failure dialog; the
 *  device-code dialog logs it and still shows the code. */
const copyToClipboard = (text: string) =>
  fromHostSync('clipboard.writeText', () => clipboard.writeText(text));

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
        message: SIGN_IN_PROMPT.inProgress(names.displayName),
        detail: `Opened your default browser. ${SIGN_IN_PROMPT.otherBrowser(names.sessionName)}`,
        choices: [
          { label: SIGN_IN_PROMPT.copyLinkLabel, value: url, default: true },
        ],
        close: 'Close',
      }).pipe(
        Effect.flatMap((copy) => (copy ? copyToClipboard(copy) : Effect.void)),
      ),
    presentSubscriptionDeviceCode: Effect.fn('presentSubscriptionDeviceCode')(
      function* (
        prompt: SubscriptionDeviceCodePrompt,
        names: SignInNames,
        reason: string | undefined,
      ) {
        const { displayName } = names;
        // Copied up front: the dialog closes on any button. A failed copy
        // still shows the code, which the dialog then does not call copied.
        const copied = yield* copyToClipboard(prompt.userCode).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning(
              SIGN_IN_PROMPT.codeCopyFailed(displayName, error.message),
            ).pipe(Effect.as(false)),
          ),
        );
        const steps = SIGN_IN_PROMPT.deviceCodeSteps(
          displayName,
          prompt,
          copied,
        );
        const verificationUrl = yield* choose(window, {
          type: 'info',
          message: SUBSCRIPTION_AUTH_COPY[names.id].signInLabel,
          detail: reason === undefined ? steps : `${reason}\n\n${steps}`,
          choices: [
            {
              label: SIGN_IN_PROMPT.openVerificationLabel,
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
