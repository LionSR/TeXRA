/**
 * Grok-subscription (xAI) sign-in handlers for Settings → Subscriptions.
 */
import * as vscode from 'vscode';

import { xaiCoordinator } from '@auth/xai';
import { getGrokAuthStatus } from '@controllers/modelAccess/grokAuthStatus';
import { signInWithGrokSubscription } from '@frontend/auth/xaiSubscriptionSignIn';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';
import { buildGrokAuthStatusMessage } from '@shared/settingsView/handlers/grokHandlers';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Grok-subscription sign-in handler delegate. */
export class GrokSubscriptionHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshModelAccess: () => Promise<void>,
  ) {}

  async sendGrokAuthStatus(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildGrokAuthStatusMessage(getGrokAuthStatus),
    );
  }

  private async refreshGrokState(): Promise<void> {
    await Promise.all([
      this.ctx.withActiveWebview((w) => this.sendGrokAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  async handleSignInGrok(): Promise<void> {
    await signInWithGrokSubscription(this.ctx.channel);
    await this.refreshGrokState();
  }

  async handleSignOutGrok(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Grok sign-out failed',
      async () => {
        await xaiCoordinator().signOut();
        void vscode.window.showInformationMessage('Signed out of Grok.');
        await this.refreshGrokState();
      },
    );
  }

  async handleSetPreferSubscription(enabled: boolean): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Could not update the Grok subscription preference',
      async () => {
        const update = await setPreferXaiSubscription(enabled);
        if (update.effective !== enabled) {
          void vscode.window.showWarningMessage(
            `A more specific setting still keeps Grok subscription ${update.effective ? 'enabled' : 'disabled'}.`,
          );
        }
      },
    );
    await this.refreshGrokState();
  }
}
