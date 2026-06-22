// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  setPreferCodexSubscription,
  type CodexSession,
} from '@auth/codex';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';

async function runChatGptSignIn(): Promise<CodexSession> {
  const coordinator = codexCoordinator();
  if (vscode.env.remoteName) {
    return loginWithDeviceCode({
      coordinator,
      onPrompt: (prompt) => {
        void vscode.env.clipboard.writeText(prompt.userCode);
        void vscode.window
          .showInformationMessage(
            `Enter ChatGPT code ${prompt.userCode} at ${prompt.verificationUrl}. The code was copied to the clipboard.`,
            'Open ChatGPT',
          )
          .then((choice) => {
            if (choice === 'Open ChatGPT') {
              void vscode.env.openExternal(
                vscode.Uri.parse(prompt.verificationUrl),
              );
            }
          });
      },
    });
  }

  return loginWithLoopback({
    coordinator,
    openBrowser: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });
}

/** Run ChatGPT sign-in and enable subscription routing for Codex models. */
export async function signInWithChatGptSubscription(
  channel: string,
): Promise<boolean> {
  let session: CodexSession;
  try {
    session = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in with ChatGPT...',
        cancellable: false,
      },
      () => runChatGptSignIn(),
    );
  } catch (error) {
    await showLoggedErrorMessage(channel, 'ChatGPT sign-in failed', error);
    return false;
  }

  const label = session.email ?? session.accountId ?? 'your account';
  let update: Awaited<ReturnType<typeof setPreferCodexSubscription>>;
  try {
    update = await setPreferCodexSubscription(true);
  } catch (error) {
    await showLoggedErrorMessage(
      channel,
      'ChatGPT sign-in succeeded but subscription preference update failed',
      error,
    );
    return false;
  }

  if (update.effective) {
    void vscode.window.showInformationMessage(
      `Signed in with ChatGPT as ${label}. ChatGPT subscription is enabled for Codex models.`,
    );
    return true;
  }
  void vscode.window.showWarningMessage(
    `Signed in with ChatGPT as ${label}, but a more specific setting kept the subscription preference disabled.`,
  );
  return false;
}
