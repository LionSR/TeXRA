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
  getChatGptAuthStatus,
  setCodexSubscriptionToolUseOnly,
  setPreferCodexSubscription,
} from '@auth/codex';
import { signInWithChatGptSubscription } from '@frontend/auth/codexSubscriptionSignIn';
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
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      status: await getChatGptAuthStatus(),
    });
  }

  private async refreshChatGptState(): Promise<void> {
    await Promise.all([
      this.ctx.withActiveWebview((w) => this.sendChatGptAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  async handleSignInChatGpt(): Promise<void> {
    await signInWithChatGptSubscription(this.ctx.channel);
    await this.refreshChatGptState();
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

  async handleSetSubscriptionToolUseOnly(enabled: boolean): Promise<void> {
    try {
      const update = await setCodexSubscriptionToolUseOnly(enabled);
      if (update.effective !== enabled) {
        void vscode.window.showWarningMessage(
          `The effective "subscription for tool-use only" setting remains ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Could not update the ChatGPT subscription scope',
        error,
      );
    } finally {
      await this.refreshChatGptState();
    }
  }
}
