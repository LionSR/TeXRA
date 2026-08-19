/**
 * Subscription sign-in handlers for Settings → Subscriptions.
 *
 * ChatGPT (Codex) and Grok (xAI) run the identical flow: a host-neutral OAuth
 * sign-in, a sign-out through the provider's auth coordinator, a routing
 * preference write, and a status round-trip back to the settings webview after
 * each. Everything provider-specific except the outbound wire message comes
 * from the shared `SUBSCRIPTION_PROVIDERS` catalog, so this file configures a
 * provider by id plus its status-message builder.
 */
import * as vscode from 'vscode';

import {
  subscriptionProvider,
  type SubscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import type {
  UpdateChatGptAuthStatusMessage,
  UpdateGrokAuthStatusMessage,
} from '@shared/schemas';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Outbound status message a subscription provider pushes to the webview. */
type SubscriptionAuthStatusMessage =
  UpdateChatGptAuthStatusMessage | UpdateGrokAuthStatusMessage;

/** Subscription sign-in handler delegate for one provider. */
export class SubscriptionHandlers {
  private readonly provider: SubscriptionProvider;

  constructor(
    private readonly providerId: SubscriptionProviderId,
    /** Current sign-in status, already wrapped as its outbound wire message. */
    private readonly buildStatusMessage: () => Promise<SubscriptionAuthStatusMessage>,
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshModelAccess: () => Promise<void>,
  ) {
    this.provider = subscriptionProvider(providerId);
  }

  async sendAuthStatus(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(await this.buildStatusMessage());
  }

  private async refreshState(): Promise<void> {
    await Promise.all([
      this.ctx.withActiveWebview((w) => this.sendAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  readonly handleSignIn = async (): Promise<void> => {
    await signInWithSubscription(this.ctx.channel, this.providerId);
    await this.refreshState();
  };

  async handleSignOut(): Promise<void> {
    const { displayName } = this.provider;
    await withHandlerErrorHandling(
      this.ctx,
      `${displayName} sign-out failed`,
      async () => {
        await this.provider.signOut();
        void vscode.window.showInformationMessage(
          `Signed out of ${displayName}.`,
        );
        await this.refreshState();
      },
    );
  }

  /**
   * Apply the subscription preference, warn when a more specific setting
   * overrides the requested value, log failures, and always refresh the
   * settings view.
   */
  async handleSetPreferSubscription(enabled: boolean): Promise<void> {
    const { displayName } = this.provider;
    await withHandlerErrorHandling(
      this.ctx,
      `Could not update the ${displayName} subscription preference`,
      async () => {
        const update = await this.provider.setPreferSubscription(enabled);
        if (update.effective !== enabled) {
          void vscode.window.showWarningMessage(
            `A more specific setting still keeps ${displayName} subscription ${update.effective ? 'enabled' : 'disabled'}.`,
          );
        }
      },
    );
    await this.refreshState();
  }
}
