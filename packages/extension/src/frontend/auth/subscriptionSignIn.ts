// Third-party imports
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
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

const OPEN_DEFAULT_BROWSER = 'Open in Default Browser';
const COPY_SIGN_IN_LINK = 'Copy Sign-in Link';

/** Dismissing the browser-choice dialog cancels sign-in, matching this
 * repo's modal convention (e.g. authCommands.ts, compareCommands.ts). */
class SubscriptionSignInCancelled extends Error {}

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
    presentSignInUrl: async (url) => {
      // `openExternal` always targets the system default browser. The loopback
      // callback accepts the redirect from *any* browser, so ask up front
      // instead of racing an auto-launched tab against a dismissible toast —
      // users whose subscription lives in a different browser (e.g. default is
      // Safari but the provider is signed in on Chrome) get a link they can
      // paste there instead.
      const choice = await vscode.window.showInformationMessage(
        `Sign in with ${displayName}. If your ${sessionName} session is in a different browser than your OS default, copy the link and open it there instead.`,
        { modal: true },
        OPEN_DEFAULT_BROWSER,
        COPY_SIGN_IN_LINK,
      );
      if (choice === COPY_SIGN_IN_LINK) {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.showInformationMessage(
          `Sign-in link copied. Paste it into the browser where you use ${copyTarget}.`,
        );
        return;
      }
      if (choice !== OPEN_DEFAULT_BROWSER) {
        throw new SubscriptionSignInCancelled();
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  };
}

/** Run subscription sign-in and enable subscription routing for the
 * provider's models. */
export async function signInWithSubscription(
  channel: string,
  providerId: SubscriptionProviderId,
): Promise<boolean> {
  const provider = subscriptionProvider(providerId);
  const { displayName, modelFamily } = provider;
  let account: SubscriptionAccount;
  try {
    account = await vscode.window.withProgress(
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
    );
  } catch (error) {
    if (error instanceof SubscriptionSignInCancelled) {
      return false;
    }
    await showLoggedErrorMessage(
      channel,
      `${displayName} sign-in failed`,
      error,
    );
    return false;
  }

  let update: { effective: boolean };
  try {
    update = await provider.setPreferSubscription(true);
    // The sign-in operation owns its model-availability postcondition. Every
    // caller may now refresh a picker without inheriting a stale pre-login
    // snapshot, including paths that do not pass through Settings.
    invalidateModelOptionsCache();
  } catch (error) {
    await showLoggedErrorMessage(
      channel,
      `${displayName} sign-in succeeded but subscription preference update failed`,
      error,
    );
    return false;
  }

  if (update.effective) {
    void vscode.window.showInformationMessage(
      `Signed in with ${displayName} as ${account.label}. ${displayName} subscription is enabled for ${modelFamily}.`,
    );
    return true;
  }
  void vscode.window.showWarningMessage(
    `Signed in with ${displayName} as ${account.label}, but a more specific setting kept the subscription preference disabled.`,
  );
  return false;
}
