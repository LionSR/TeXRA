// Third-party imports
import { Cause, Data, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProvider,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
} from '@controllers/modelAccess/subscriptionProviders';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import type { Secrets } from '@platform/secrets';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { HttpClient } from 'effect/unstable/http';

const OPEN_DEFAULT_BROWSER = 'Open in Default Browser';
const COPY_SIGN_IN_LINK = 'Copy Sign-in Link';

/** Dismissing the browser-choice dialog cancels sign-in, matching this
 * repo's modal convention (e.g. authCommands.ts, compareCommands.ts). */
class SubscriptionSignInCancelled extends Error {}

/**
 * The OAuth leg's failure, carrying whatever the transport threw so the same
 * value reaches the same report. A dismissed browser-choice dialog arrives
 * here too, as a {@link SubscriptionSignInCancelled} cause.
 */
class SubscriptionSignInFailed extends Data.TaggedError(
  'SubscriptionSignInFailed',
)<{ readonly cause: unknown }> {}

/** The preference write's failure, after a sign-in that already succeeded. */
class SubscriptionPreferenceUpdateFailed extends Data.TaggedError(
  'SubscriptionPreferenceUpdateFailed',
)<{ readonly cause: unknown }> {}

/** How VS Code shows a subscription sign-in prompt. */
function vscodePresenter(
  provider: SubscriptionProvider,
): SubscriptionSignInPresenter {
  const { displayName, sessionName, copyTarget } = provider;
  return {
    presentDeviceCode: (prompt) => {
      void vscode.env.clipboard.writeText(prompt.userCode);
      const openUrl = prompt.verificationUrlComplete ?? prompt.verificationUrl;
      void vscode.window
        .showInformationMessage(
          `Enter ${displayName} code ${prompt.userCode} at ${prompt.verificationUrl}. The code was copied to the clipboard.`,
          `Open ${displayName}`,
        )
        .then((choice) => {
          if (choice === `Open ${displayName}`) {
            void vscode.env.openExternal(vscode.Uri.parse(openUrl));
          }
        });
    },
    presentSignInUrl: (url) =>
      Effect.gen(function* () {
        // `openExternal` always targets the system default browser. The
        // loopback callback accepts the redirect from *any* browser, so ask up
        // front instead of racing an auto-launched tab against a dismissible
        // toast — users whose subscription lives in a different browser (e.g.
        // default is Safari but the provider is signed in on Chrome) get a
        // link they can paste there instead.
        const choice = yield* Effect.promise(() =>
          vscode.window.showInformationMessage(
            `Sign in with ${displayName}. If your ${sessionName} session is in a different browser than your OS default, copy the link and open it there instead.`,
            { modal: true },
            OPEN_DEFAULT_BROWSER,
            COPY_SIGN_IN_LINK,
          ),
        );
        if (choice === COPY_SIGN_IN_LINK) {
          yield* Effect.promise(() => vscode.env.clipboard.writeText(url));
          void vscode.window.showInformationMessage(
            `Sign-in link copied. Paste it into the browser where you use ${copyTarget}.`,
          );
          return;
        }
        if (choice !== OPEN_DEFAULT_BROWSER) {
          return yield* Effect.fail(new SubscriptionSignInCancelled());
        }
        yield* Effect.promise(() =>
          vscode.env.openExternal(vscode.Uri.parse(url)),
        );
      }),
  };
}

/**
 * Run subscription sign-in and enable subscription routing for the provider's
 * models. The whole flow is one program the caller settles at its own
 * boundary: the OAuth leg is a step of it, under a progress notification that
 * lives for exactly as long as that step.
 */
export function signInWithSubscription(
  stores: SettingsStores,
  channel: string,
  providerId: SubscriptionProviderId,
): Effect.Effect<boolean, never, HttpClient.HttpClient | Secrets> {
  const provider = subscriptionProvider(providerId);
  const { displayName, modelFamily } = provider;

  return Effect.gen(function* () {
    const account: SubscriptionAccount = yield* withVSCodeProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Signing in with ${displayName}...`,
        cancellable: false,
      },
      () =>
        provider.signIn({
          // Remote windows cannot reach the extension host's loopback port
          // from the user's local browser.
          transport: vscode.env.remoteName ? 'device' : 'loopback',
          present: vscodePresenter(provider),
        }),
    ).pipe(
      // A transport defect is reported the same as its typed failure, exactly
      // as the rejection this replaces was. An interrupt is not: shutdown
      // cancelling the sign-in is not a sign-in failure, and the
      // `Effect.tryPromise` this replaces never saw one.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              new SubscriptionSignInFailed({ cause: Cause.squash(cause) }),
            ),
      ),
    );

    const update = yield* provider
      .setPreferSubscription(stores, true)
      .pipe(
        Effect.mapError(
          (cause) => new SubscriptionPreferenceUpdateFailed({ cause }),
        ),
      );

    if (update.effective) {
      void vscode.window.showInformationMessage(
        `${ACCOUNT_OUTCOME.signedInAs(displayName, account.label)} ${displayName} subscription is enabled for ${modelFamily}.`,
      );
      return true;
    }
    void vscode.window.showWarningMessage(
      `Signed in with ${displayName} as ${account.label}, but a more specific setting kept the subscription preference disabled.`,
    );
    return false;
  }).pipe(
    Effect.catchTag('SubscriptionSignInFailed', (failure) =>
      failure.cause instanceof SubscriptionSignInCancelled
        ? Effect.succeed(false)
        : showLoggedErrorMessage(
            channel,
            `${displayName} sign-in failed`,
            failure.cause,
          ).pipe(Effect.as(false)),
    ),
    Effect.catchTag('SubscriptionPreferenceUpdateFailed', (failure) =>
      showLoggedErrorMessage(
        channel,
        `${displayName} sign-in succeeded but subscription preference update failed`,
        failure.cause,
      ).pipe(Effect.as(false)),
    ),
  );
}
