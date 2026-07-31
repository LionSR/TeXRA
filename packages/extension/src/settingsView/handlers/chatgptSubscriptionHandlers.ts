/**
 * ChatGPT-subscription (Codex) sign-in handlers for Settings → Models.
 *
 * Drives the experimental "Sign in with ChatGPT" control: runs the host-neutral
 * loopback OAuth flow (from `@auth/codex`) with the VS Code browser opener, then
 * pushes the signed-in status back to the settings webview. Mirrors the
 * GitHub-token status round-trip.
 */
import * as vscode from 'vscode';

import { codexCoordinator } from '@auth/codex';
import { getChatGptAuthStatus } from '@controllers/modelAccess/chatGptAuthStatus';
import { signInWithChatGptSubscription } from '@frontend/auth/codexSubscriptionSignIn';
import {
  setCodexSubscriptionToolUseOnly,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import { buildChatGptAuthStatusMessage } from '@shared/settingsView/handlers/chatGptHandlers';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** ChatGPT-subscription sign-in handler delegate. */
export class ChatGptSubscriptionHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshModelAccess: () => Promise<void>,
  ) {}

  async sendChatGptAuthStatus(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildChatGptAuthStatusMessage(getChatGptAuthStatus),
    );
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
    await withHandlerErrorHandling(
      this.ctx,
      'ChatGPT sign-out failed',
      async () => {
        await codexCoordinator().signOut();
        void vscode.window.showInformationMessage('Signed out of ChatGPT.');
        await this.refreshChatGptState();
      },
    );
  }

  async handleSetPreferSubscription(enabled: boolean): Promise<void> {
    await this.applySubscriptionSetting({
      enabled,
      apply: setPreferCodexSubscription,
      warning: (effective) =>
        `A more specific setting still keeps ChatGPT subscription ${effective ? 'enabled' : 'disabled'}.`,
      errorMessage: 'Could not update the ChatGPT subscription preference',
    });
  }

  async handleSetSubscriptionToolUseOnly(enabled: boolean): Promise<void> {
    await this.applySubscriptionSetting({
      enabled,
      apply: setCodexSubscriptionToolUseOnly,
      warning: (effective) =>
        `The effective "subscription for tool-use only" setting remains ${effective ? 'enabled' : 'disabled'}.`,
      errorMessage: 'Could not update the ChatGPT subscription scope',
    });
  }

  /**
   * Apply a subscription toggle, warn when a more specific setting overrides the
   * requested value, log failures, and always refresh the settings view.
   */
  private async applySubscriptionSetting(opts: {
    enabled: boolean;
    apply: (enabled: boolean) => Promise<{ effective: boolean }>;
    warning: (effective: boolean) => string;
    errorMessage: string;
  }): Promise<void> {
    await withHandlerErrorHandling(this.ctx, opts.errorMessage, async () => {
      const update = await opts.apply(opts.enabled);
      if (update.effective !== opts.enabled) {
        void vscode.window.showWarningMessage(opts.warning(update.effective));
      }
    });
    await this.refreshChatGptState();
  }
}
