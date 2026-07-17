/**
 * Kimi Code-subscription sign-in handlers for Settings → Models.
 *
 * Drives the experimental "Sign in with Kimi Code" control: runs the
 * host-neutral device-code OAuth flow (from `@auth/kimiCode`) with VS Code
 * prompts, then pushes the signed-in status back to the settings webview.
 * Mirrors the ChatGPT-subscription status round-trip.
 */
import * as vscode from 'vscode';

import {
  getKimiCodeAuthStatus,
  kimiCodeCoordinator,
  setKimiCodeSubscriptionToolUseOnly,
  setPreferKimiCodeSubscription,
} from '@auth/kimiCode';
import { signInWithKimiCodeSubscription } from '@frontend/auth/kimiCodeSubscriptionSignIn';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { buildKimiCodeAuthStatusMessage } from '@shared/settingsView/handlers/chatGptHandlers';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/** Kimi Code-subscription sign-in handler delegate. */
export class KimiCodeSubscriptionHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshModelAccess: () => Promise<void>,
  ) {}

  async sendKimiCodeAuthStatus(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildKimiCodeAuthStatusMessage(getKimiCodeAuthStatus),
    );
  }

  private async refreshKimiCodeState(): Promise<void> {
    await Promise.all([
      this.ctx.withActiveWebview((w) => this.sendKimiCodeAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  async handleSignInKimiCode(): Promise<void> {
    await signInWithKimiCodeSubscription(this.ctx.channel);
    await this.refreshKimiCodeState();
  }

  async handleSignOutKimiCode(): Promise<void> {
    try {
      await kimiCodeCoordinator().signOut();
      void vscode.window.showInformationMessage('Signed out of Kimi Code.');
      await this.refreshKimiCodeState();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Kimi Code sign-out failed',
        error,
      );
    }
  }

  async handleSetPreferSubscription(enabled: boolean): Promise<void> {
    await this.applySubscriptionSetting({
      enabled,
      apply: setPreferKimiCodeSubscription,
      warning: (effective) =>
        `A more specific setting still keeps Kimi Code subscription ${effective ? 'enabled' : 'disabled'}.`,
      errorMessage: 'Could not update the Kimi Code subscription preference',
    });
  }

  async handleSetSubscriptionToolUseOnly(enabled: boolean): Promise<void> {
    await this.applySubscriptionSetting({
      enabled,
      apply: setKimiCodeSubscriptionToolUseOnly,
      warning: (effective) =>
        `The effective "subscription for tool-use only" setting remains ${effective ? 'enabled' : 'disabled'}.`,
      errorMessage: 'Could not update the Kimi Code subscription scope',
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
    try {
      const update = await opts.apply(opts.enabled);
      if (update.effective !== opts.enabled) {
        void vscode.window.showWarningMessage(opts.warning(update.effective));
      }
    } catch (error) {
      await showLoggedErrorMessage(this.ctx.channel, opts.errorMessage, error);
    } finally {
      await this.refreshKimiCodeState();
    }
  }
}
