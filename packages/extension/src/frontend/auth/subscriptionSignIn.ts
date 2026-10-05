// Third-party imports
import { Cause, Data, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import { withLogChannel } from '@logger/effectLog';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { ACCOUNT_OUTCOME } from '@shared/model/accountAuth';
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProvider,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { ensureError } from '@utils/errors/errorMessage';
import type { Secrets } from '@texra-ai/harness';
import type { HttpClient } from 'effect/http';

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

const externalOpener = new VscodeExternalOpener();

/** How VS Code shows a subscription sign-in prompt. */
function vscodePresenter(
  provider: SubscriptionProvider,
  channel: string,
): SubscriptionSignInPresenter {
  const { displayName, sessionName, copyTarget } = provider;
  return {
    presentDeviceCode: (prompt) =>
      Effect.gen(function* () {
        const copied = yield* Effect.tryPromise({
          try: () => vscode.env.clipboard.writeText(prompt.userCode),
          catch: ensureError,
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not copy the ${displayName} sign-in code: ${error.message}`,
            ).pipe(withLogChannel(channel), Effect.as(false)),
          ),
        );
        const openLabel = `Open ${displayName}`;
        const choice = yield* vscodeUi.info(
          `Enter ${displayName} code ${prompt.userCode} at ${prompt.verificationUrl}.${copied ? ' The code was copied to the clipboard.' : ''}`,
          { items: [openLabel] },
        );
        if (choice === openLabel) {
          yield* externalOpener.openExternal(
            prompt.verificationUrlComplete ?? prompt.verificationUrl,
          );
        }
      }).pipe(
        // The flow does not wait for this prompt, so its failure has no
        // caller to reach: it is reported here, once.
        Effect.catch((error) =>
          showLoggedErrorMessage(
            channel,
            `${displayName} sign-in code could not be shown`,
            error,
          ),
        ),
        Effect.asVoid,
      ),
    presentSignInUrl: (url) =>
      Effect.gen(function* () {
        // `openExternal` always targets the system default browser. The
        // loopback callback accepts the redirect from *any* browser, so ask up
        // front instead of racing an auto-launched tab against a dismissible
        // toast — users whose subscription lives in a different browser (e.g.
        // default is Safari but the provider is signed in on Chrome) get a
        // link they can paste there instead.
        const choice = yield* vscodeUi.info(
          `Sign in with ${displayName}. If your ${sessionName} session is in a different browser than your OS default, copy the link and open it there instead.`,
          { modal: true, items: [OPEN_DEFAULT_BROWSER, COPY_SIGN_IN_LINK] },
        );
        if (choice === COPY_SIGN_IN_LINK) {
          yield* Effect.tryPromise({
            try: () => vscode.env.clipboard.writeText(url),
            catch: ensureError,
          });
          yield* Effect.forkDetach(
            showLoggedInfoMessage(
              channel,
              `Sign-in link copied. Paste it into the browser where you use ${copyTarget}.`,
            ),
          );
          return;
        }
        if (choice !== OPEN_DEFAULT_BROWSER) {
          return yield* Effect.fail(new SubscriptionSignInCancelled());
        }
        yield* externalOpener.openExternal(url);
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
          // from the user's local browser. Locally, `auto` drops to a device
          // code when the callback ports are taken (another sign-in holding
          // them) instead of failing with a bind error.
          transport: vscode.env.remoteName ? 'device' : 'auto',
          present: vscodePresenter(provider, channel),
        }),
    ).pipe(
      // A transport defect is reported the same as its typed failure. An
      // interrupt is not: shutdown cancelling the sign-in is not a sign-in
      // failure.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              new SubscriptionSignInFailed({ cause: Cause.squash(cause) }),
            ),
      ),
    );

    yield* provider
      .setPreferSubscription(stores, true)
      .pipe(
        Effect.mapError(
          (cause) => new SubscriptionPreferenceUpdateFailed({ cause }),
        ),
      );

    yield* Effect.forkDetach(
      showLoggedInfoMessage(
        channel,
        `${ACCOUNT_OUTCOME.signedInAs(displayName, account.label)} ${displayName} subscription is enabled for ${modelFamily}.`,
      ),
    );
    return true;
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
