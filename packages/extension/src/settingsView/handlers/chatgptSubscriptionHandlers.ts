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
  loginWithLoopback,
} from '@auth/codex';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/** ChatGPT-subscription sign-in handler delegate. */
export class ChatGptSubscriptionHandlers {
  constructor(private readonly ctx: SettingsHandlerContext) {}

  async sendChatGptAuthStatus(webview: vscode.Webview): Promise<void> {
    const status = await getCodexStatus();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      status,
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
        () =>
          loginWithLoopback({
            coordinator: codexCoordinator(),
            openBrowser: async (url) => {
              await vscode.env.openExternal(vscode.Uri.parse(url));
            },
          }),
      );
      void vscode.window.showInformationMessage(
        `Signed in with ChatGPT as ${session.email ?? session.accountId ?? 'your account'}.`,
      );
      await this.ctx.withActiveWebview((w) => this.sendChatGptAuthStatus(w));
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
      await this.ctx.withActiveWebview((w) => this.sendChatGptAuthStatus(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'ChatGPT sign-out failed',
        error,
      );
    }
  }
}
