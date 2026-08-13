// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

const OPEN_DEFAULT_BROWSER = 'Open in Default Browser';
const COPY_SIGN_IN_LINK = 'Copy Sign-in Link';

/** Dismissing the browser-choice dialog cancels sign-in, matching this
 * repo's modal convention (e.g. authCommands.ts, compareCommands.ts). */
class SubscriptionSignInCancelled extends Error {}

interface DeviceCodePrompt {
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
}

/** Per-provider wiring for the shared subscription sign-in flow. */
interface SubscriptionSignInProvider<Coordinator, Session> {
  coordinator: () => Coordinator;
  loginWithDeviceCode: (options: {
    coordinator: Coordinator;
    onPrompt: (prompt: DeviceCodePrompt) => void;
  }) => Promise<Session>;
  loginWithLoopback: (options: {
    coordinator: Coordinator;
    openBrowser: (url: string) => void | Promise<void>;
  }) => Promise<Session>;
  accountLabel: (session: Session) => string;
  setPreferSubscription: (enabled: boolean) => Promise<{
    effective: boolean;
  }>;
  nouns: {
    /** Display name in prompts, titles, and errors ('ChatGPT', 'Grok'). */
    provider: string;
    /** Account the browser session belongs to ('ChatGPT', 'xAI'). */
    session: string;
    /** Copy-link toast target ('ChatGPT', 'Grok / xAI'). */
    copyTarget: string;
    /** Model family the subscription unlocks ('Codex', 'xAI'). */
    models: string;
  };
}

async function runSubscriptionSignIn<Coordinator, Session>(
  provider: SubscriptionSignInProvider<Coordinator, Session>,
): Promise<Session> {
  const { provider: name, session, copyTarget } = provider.nouns;
  const coordinator = provider.coordinator();
  if (vscode.env.remoteName) {
    return provider.loginWithDeviceCode({
      coordinator,
      onPrompt: (prompt) => {
        void vscode.env.clipboard.writeText(prompt.userCode);
        const openUrl =
          prompt.verificationUrlComplete ?? prompt.verificationUrl;
        void vscode.window
          .showInformationMessage(
            `Enter ${name} code ${prompt.userCode} at ${prompt.verificationUrl}. The code was copied to the clipboard.`,
            `Open ${name}`,
          )
          .then((choice) => {
            if (choice === `Open ${name}`) {
              void vscode.env.openExternal(vscode.Uri.parse(openUrl));
            }
          });
      },
    });
  }

  return provider.loginWithLoopback({
    coordinator,
    openBrowser: async (url) => {
      // `openExternal` always targets the system default browser. The loopback
      // callback accepts the redirect from *any* browser, so ask up front
      // instead of racing an auto-launched tab against a dismissible toast —
      // users whose subscription lives in a different browser (e.g. default is
      // Safari but the provider is signed in on Chrome) get a link they can
      // paste there instead.
      const choice = await vscode.window.showInformationMessage(
        `Sign in with ${name}. If your ${session} session is in a different browser than your OS default, copy the link and open it there instead.`,
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
  });
}

/** Run subscription sign-in and enable subscription routing for the
 * provider's models. */
export async function signInWithSubscription<Coordinator, Session>(
  channel: string,
  provider: SubscriptionSignInProvider<Coordinator, Session>,
): Promise<boolean> {
  const { provider: name, models } = provider.nouns;
  let session: Session;
  try {
    session = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Signing in with ${name}...`,
        cancellable: false,
      },
      () => runSubscriptionSignIn(provider),
    );
  } catch (error) {
    if (error instanceof SubscriptionSignInCancelled) {
      return false;
    }
    await showLoggedErrorMessage(channel, `${name} sign-in failed`, error);
    return false;
  }

  const label = provider.accountLabel(session);
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
      `${name} sign-in succeeded but subscription preference update failed`,
      error,
    );
    return false;
  }

  if (update.effective) {
    void vscode.window.showInformationMessage(
      `Signed in with ${name} as ${label}. ${name} subscription is enabled for ${models} models.`,
    );
    return true;
  }
  void vscode.window.showWarningMessage(
    `Signed in with ${name} as ${label}, but a more specific setting kept the subscription preference disabled.`,
  );
  return false;
}
