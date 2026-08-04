// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  loginWithDeviceCode,
  loginWithLoopback,
  xaiAccountLabel,
  xaiCoordinator,
  type XaiSession,
} from '@auth/xai';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';

const OPEN_DEFAULT_BROWSER = 'Open in Default Browser';
const COPY_SIGN_IN_LINK = 'Copy Sign-in Link';

/** Dismissing the browser-choice dialog cancels sign-in. */
class GrokSignInCancelled extends Error {}

async function runGrokSignIn(): Promise<XaiSession> {
  const coordinator = xaiCoordinator();
  if (vscode.env.remoteName) {
    return loginWithDeviceCode({
      coordinator,
      onPrompt: (prompt) => {
        void vscode.env.clipboard.writeText(prompt.userCode);
        const openUrl =
          prompt.verificationUrlComplete ?? prompt.verificationUrl;
        void vscode.window
          .showInformationMessage(
            `Enter Grok code ${prompt.userCode} at ${prompt.verificationUrl}. The code was copied to the clipboard.`,
            'Open Grok',
          )
          .then((choice) => {
            if (choice === 'Open Grok') {
              void vscode.env.openExternal(vscode.Uri.parse(openUrl));
            }
          });
      },
    });
  }

  return loginWithLoopback({
    coordinator,
    openBrowser: async (url) => {
      const choice = await vscode.window.showInformationMessage(
        'Sign in with Grok. If your xAI session is in a different browser than your OS default, copy the link and open it there instead.',
        { modal: true },
        OPEN_DEFAULT_BROWSER,
        COPY_SIGN_IN_LINK,
      );
      if (choice === COPY_SIGN_IN_LINK) {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.showInformationMessage(
          'Sign-in link copied. Paste it into the browser where you use Grok / xAI.',
        );
        return;
      }
      if (choice !== OPEN_DEFAULT_BROWSER) {
        throw new GrokSignInCancelled();
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });
}

/** Run Grok sign-in and enable subscription routing for xAI models. */
export async function signInWithGrokSubscription(
  channel: string,
): Promise<boolean> {
  let session: XaiSession;
  try {
    session = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in with Grok...',
        cancellable: false,
      },
      () => runGrokSignIn(),
    );
  } catch (error) {
    if (error instanceof GrokSignInCancelled) {
      return false;
    }
    await showLoggedErrorMessage(channel, 'Grok sign-in failed', error);
    return false;
  }

  const label = xaiAccountLabel(session);
  let update: Awaited<ReturnType<typeof setPreferXaiSubscription>>;
  try {
    update = await setPreferXaiSubscription(true);
    invalidateModelOptionsCache();
  } catch (error) {
    await showLoggedErrorMessage(
      channel,
      'Grok sign-in succeeded but subscription preference update failed',
      error,
    );
    return false;
  }

  if (update.effective) {
    void vscode.window.showInformationMessage(
      `Signed in with Grok as ${label}. Grok subscription is enabled for xAI models.`,
    );
    return true;
  }
  void vscode.window.showWarningMessage(
    `Signed in with Grok as ${label}, but a more specific setting kept the subscription preference disabled.`,
  );
  return false;
}
