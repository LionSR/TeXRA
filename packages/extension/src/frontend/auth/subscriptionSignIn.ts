// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { Cancelled, ensureError } from '@texra-ai/harness/schemas';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProvider,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import type { AppSignals, SettingsStores } from '@texra-ai/harness/plugins';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';
import type { HttpClient } from 'effect/http';

const OPEN_DEFAULT_BROWSER = 'Open in Default Browser';
const COPY_SIGN_IN_LINK = 'Copy Sign-in Link';

const externalOpener = new VscodeExternalOpener();

/** How VS Code shows a subscription sign-in prompt. */
function vscodePresenter(
  provider: SubscriptionProvider,
): SubscriptionSignInPresenter {
  const { displayName, sessionName, copyTarget } = provider;
  return {
    presentDeviceCode: Effect.fn('presentDeviceCode')(
      function* (prompt) {
        const copied = yield* Effect.tryPromise({
          try: () => vscode.env.clipboard.writeText(prompt.userCode),
          catch: ensureError,
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not copy the ${displayName} sign-in code: ${error.message}`,
            ).pipe(Effect.as(false)),
          ),
        );
        const openLabel = `Open ${displayName}`;
        const choice = yield* vscodeUi.ask(
          'info',
          `Enter ${displayName} code ${prompt.userCode} at ${prompt.verificationUrl}.${copied ? ' The code was copied to the clipboard.' : ''}`,
          { items: [openLabel] },
        );
        if (choice === openLabel) {
          yield* externalOpener.openExternal(
            prompt.verificationUrlComplete ?? prompt.verificationUrl,
          );
        }
      },
      Effect.catch((error) =>
        showLoggedErrorMessage(
          `${displayName} sign-in code could not be shown`,
          error,
        ),
      ),
      Effect.asVoid,
    ),
    presentSignInUrl: Effect.fn('subscriptionSignIn.presentSignInUrl')(
      function* (url) {
        // `openExternal` always targets the system default browser. The
        // loopback callback accepts the redirect from *any* browser, so ask up
        // front instead of racing an auto-launched tab against a dismissible
        // toast — users whose subscription lives in a different browser (e.g.
        // default is Safari but the provider is signed in on Chrome) get a
        // link they can paste there instead.
        const choice = yield* vscodeUi.ask(
          'info',
          `Sign in with ${displayName}. If your ${sessionName} session is in a different browser than your OS default, copy the link and open it there instead.`,
          { modal: true, items: [OPEN_DEFAULT_BROWSER, COPY_SIGN_IN_LINK] },
        );
        if (choice === COPY_SIGN_IN_LINK) {
          yield* Effect.tryPromise({
            try: () => vscode.env.clipboard.writeText(url),
            catch: ensureError,
          });
          yield* showLoggedInfoMessage(
            `Sign-in link copied. Paste it into the browser where you use ${copyTarget}.`,
          );
          return;
        }
        // Dismissing the browser-choice dialog cancels the sign-in, as this
        // host's other modals do.
        if (choice !== OPEN_DEFAULT_BROWSER) {
          return yield* new Cancelled();
        }
        yield* externalOpener.openExternal(url);
      },
    ),
  };
}

/**
 * Run one subscription's sign-in over VS Code's prompts, under a progress
 * notification that lives for exactly as long as the sign-in. The caller
 * tells the user how it ended; a dismissed browser-choice dialog fails with
 * `Cancelled`.
 */
export function signInWithSubscription(
  stores: SettingsStores,
  providerId: SubscriptionProviderId,
): Effect.Effect<
  SubscriptionAccount,
  Error,
  HttpClient.HttpClient | SubscriptionAccounts | AppSignals
> {
  const provider = subscriptionProvider(providerId);
  return withVSCodeProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Signing in with ${provider.displayName}...`,
      cancellable: false,
    },
    () =>
      provider.signIn({
        // Remote windows cannot reach the extension host's loopback port
        // from the user's local browser. Locally, `auto` drops to a device
        // code when the callback ports are taken (another sign-in holding
        // them) instead of failing with a bind error.
        transport: vscode.env.remoteName ? 'device' : 'auto',
        present: vscodePresenter(provider),
        stores,
      }),
  );
}
