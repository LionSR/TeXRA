/**
 * ChatGPT-subscription (Codex) sign-in handlers for Settings → Models.
 *
 * Drives the experimental "Sign in with ChatGPT" control: runs the host-neutral
 * loopback OAuth flow (from `@auth/codex`) with the VS Code browser opener, then
 * pushes the signed-in status back to the settings webview. Mirrors the
 * GitHub-token status round-trip.
 */
import * as vscode from 'vscode';

import {
  codexCoordinator,
  getCodexStatus,
  isPreferCodexSubscription,
  loginWithDeviceCode,
  loginWithLoopback,
  setPreferCodexSubscription,
} from '@auth/codex';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/** ChatGPT-subscription sign-in handler delegate. */
export class ChatGptSubscriptionHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshModelAccess: () => Promise<void>,
  ) {}

  async sendChatGptAuthStatus(webview: vscode.Webview): Promise<void> {
    const status = await getCodexStatus();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      status: { ...status, preferSubscription: isPreferCodexSubscription() },
    });
  }

  private async refreshChatGptState(): Promise<void> {
    await Promise.all([
      this.ctx.withActiveWebview((w) => this.sendChatGptAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  private async runSignIn(): Promise<
    Awaited<ReturnType<typeof loginWithLoopback>>
  > {
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

  async handleSignInChatGpt(): Promise<void> {
    try {
      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Signing in with ChatGPT…',
          cancellable: false,
        },
        () => this.runSignIn(),
      );
      void vscode.window.showInformationMessage(
        `Signed in with ChatGPT as ${session.email ?? session.accountId ?? 'your account'}.`,
      );
      await this.refreshChatGptState();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'ChatGPT sign-in failed',
        error,
      );
    }
  }

  async handleSignOutChatGpt(): Promise<void> {
    try {
      await codexCoordinator().signOut();
      void vscode.window.showInformationMessage('Signed out of ChatGPT.');
      await this.refreshChatGptState();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'ChatGPT sign-out failed',
        error,
      );
    }
  }

  async handleSetPreferSubscription(enabled: boolean): Promise<void> {
    try {
      const update = await setPreferCodexSubscription(enabled);
      if (update.effective !== enabled) {
        void vscode.window.showWarningMessage(
          `A more specific setting still keeps ChatGPT subscription ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Could not update the ChatGPT subscription preference',
        error,
      );
    } finally {
      await this.refreshChatGptState();
    }
  }
}
