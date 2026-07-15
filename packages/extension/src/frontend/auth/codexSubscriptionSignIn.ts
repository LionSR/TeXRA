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
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

const OPEN_DEFAULT_BROWSER = 'Open in Default Browser';
const COPY_SIGN_IN_LINK = 'Copy Sign-in Link';

/** Dismissing the browser-choice dialog cancels sign-in, matching this
 * repo's modal convention (e.g. authCommands.ts, compareCommands.ts). */
class ChatGptSignInCancelled extends Error {}

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
      // `openExternal` always targets the system default browser. The loopback
      // callback accepts the redirect from *any* browser, so ask up front
      // instead of racing an auto-launched tab against a dismissible toast —
      // users whose ChatGPT subscription lives in a different browser (e.g.
      // default is Safari but ChatGPT is signed in on Chrome) get a link they
      // can paste there instead.
      const choice = await vscode.window.showInformationMessage(
        'Sign in with ChatGPT. If your ChatGPT session is in a different browser than your OS default, copy the link and open it there instead.',
        { modal: true },
        OPEN_DEFAULT_BROWSER,
        COPY_SIGN_IN_LINK,
      );
      if (choice === COPY_SIGN_IN_LINK) {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.showInformationMessage(
          'Sign-in link copied. Paste it into the browser where you use ChatGPT.',
        );
        return;
      }
      if (choice !== OPEN_DEFAULT_BROWSER) {
        throw new ChatGptSignInCancelled();
      }
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
    if (error instanceof ChatGptSignInCancelled) {
      return false;
    }
    await showLoggedErrorMessage(channel, 'ChatGPT sign-in failed', error);
    return false;
  }

  const label = session.email ?? session.accountId ?? 'your account';
  let update: Awaited<ReturnType<typeof setPreferCodexSubscription>>;
  try {
    update = await setPreferCodexSubscription(true);
    // The sign-in operation owns its model-availability postcondition. Every
    // caller may now refresh a picker without inheriting a stale pre-login
    // snapshot, including paths that do not pass through Settings.
    invalidateModelOptionsCache();
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
