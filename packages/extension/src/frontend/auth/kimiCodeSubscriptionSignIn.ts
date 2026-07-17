// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  kimiCodeCoordinator,
  loginWithKimiCodeDeviceCode,
  setPreferKimiCodeSubscription,
  type KimiCodeSession,
} from '@auth/kimiCode';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

/** Run the device-code flow (the only flow the Kimi Code backend offers). */
async function runKimiCodeSignIn(): Promise<KimiCodeSession> {
  return loginWithKimiCodeDeviceCode({
    coordinator: kimiCodeCoordinator(),
    onPrompt: (prompt) => {
      void vscode.env.clipboard.writeText(prompt.userCode);
      void vscode.window
        .showInformationMessage(
          `Confirm Kimi Code code ${prompt.userCode} at ${prompt.verificationUrl}. The code was copied to the clipboard.`,
          'Open Kimi',
        )
        .then((choice) => {
          if (choice === 'Open Kimi') {
            void vscode.env.openExternal(
              vscode.Uri.parse(prompt.verificationUrl),
            );
          }
        });
    },
  });
}

/** Run Kimi Code sign-in and enable subscription routing for Kimi models. */
export async function signInWithKimiCodeSubscription(
  channel: string,
): Promise<boolean> {
  let session: KimiCodeSession;
  try {
    session = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in with Kimi Code...',
        cancellable: false,
      },
      () => runKimiCodeSignIn(),
    );
  } catch (error) {
    await showLoggedErrorMessage(channel, 'Kimi Code sign-in failed', error);
    return false;
  }

  const label = session.accountId ?? 'your account';
  let update: Awaited<ReturnType<typeof setPreferKimiCodeSubscription>>;
  try {
    update = await setPreferKimiCodeSubscription(true);
    // The sign-in operation owns its model-availability postcondition. Every
    // caller may now refresh a picker without inheriting a stale pre-login
    // snapshot, including paths that do not pass through Settings.
    invalidateModelOptionsCache();
  } catch (error) {
    await showLoggedErrorMessage(
      channel,
      'Kimi Code sign-in succeeded but subscription preference update failed',
      error,
    );
    return false;
  }

  if (update.effective) {
    void vscode.window.showInformationMessage(
      `Signed in with Kimi Code as ${label}. Kimi Code subscription is enabled for Kimi models.`,
    );
    return true;
  }
  void vscode.window.showWarningMessage(
    `Signed in with Kimi Code as ${label}, but a more specific setting kept the subscription preference disabled.`,
  );
  return false;
}
