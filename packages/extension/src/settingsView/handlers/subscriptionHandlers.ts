/**
 * Subscription sign-in handlers for Settings → Subscriptions.
 *
 * ChatGPT (Codex) and Grok (xAI) run the identical flow: a host-neutral OAuth
 * sign-in, a sign-out through the provider's auth coordinator, a routing
 * preference write, and a status round-trip back to the settings webview after
 * each. Only the coordinator, the status-message builder, the preference
 * setter, and the display name differ, so those are the descriptor
 * ({@link SubscriptionProvider}) and the flow is written once.
 */
import * as vscode from 'vscode';

import { codexCoordinator } from '@auth/codex';
import { xaiCoordinator } from '@auth/xai';
import { getChatGptAuthStatus } from '@controllers/modelAccess/chatGptAuthStatus';
import { getGrokAuthStatus } from '@controllers/modelAccess/grokAuthStatus';
import { signInWithChatGptSubscription } from '@frontend/auth/codexSubscriptionSignIn';
import { signInWithGrokSubscription } from '@frontend/auth/xaiSubscriptionSignIn';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  UpdateChatGptAuthStatusMessage,
  UpdateGrokAuthStatusMessage,
} from '@shared/schemas';
import { buildAuthStatusMessage } from '@shared/settingsView/handlers/authStatusMessage';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Outbound status message a subscription provider pushes to the webview. */
type SubscriptionAuthStatusMessage =
  UpdateChatGptAuthStatusMessage | UpdateGrokAuthStatusMessage;

/** Everything one subscription provider contributes to the shared flow. */
export interface SubscriptionProvider {
  /**
   * Name used verbatim in every user-facing string this file produces
   * ("ChatGPT sign-out failed", "Signed out of Grok.", …).
   */
  readonly displayName: string;
  /** Current sign-in status, already wrapped as its outbound wire message. */
  readonly buildStatusMessage: () => Promise<SubscriptionAuthStatusMessage>;
  /** Run the provider's OAuth sign-in against the given log channel. */
  readonly signIn: (channel: string) => Promise<void>;
  /** Clear the stored session through the provider's auth coordinator. */
  readonly signOut: () => Promise<void>;
  /** Apply the routing preference; `effective` is the value that actually won. */
  readonly setPreferSubscription: (
    enabled: boolean,
  ) => Promise<{ readonly effective: boolean }>;
}

/** Subscription sign-in handler delegate for one provider. */
export class SubscriptionHandlers {
  constructor(
    private readonly provider: SubscriptionProvider,
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshModelAccess: () => Promise<void>,
  ) {}

  async sendAuthStatus(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(await this.provider.buildStatusMessage());
  }

  private async refreshState(): Promise<void> {
    await Promise.all([
      this.ctx.withActiveWebview((w) => this.sendAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  async handleSignIn(): Promise<void> {
    await this.provider.signIn(this.ctx.channel);
    await this.refreshState();
  }

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

/**
 * Experimental "Sign in with ChatGPT": Codex-eligible models then run on the
 * user's ChatGPT Plus/Pro/Team subscription instead of an OpenAI API key.
 */
export const CHATGPT_SUBSCRIPTION_PROVIDER: SubscriptionProvider =
  Object.freeze({
    displayName: 'ChatGPT',
    buildStatusMessage: () =>
      buildAuthStatusMessage(
        SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
        getChatGptAuthStatus,
      ),
    signIn: async (channel: string) => {
      await signInWithChatGptSubscription(channel);
    },
    signOut: () => codexCoordinator().signOut(),
    setPreferSubscription: setPreferCodexSubscription,
  });

/**
 * Experimental "Sign in with Grok": xAI models then run on the user's
 * SuperGrok / xAI account OAuth token instead of an xAI API key.
 */
export const GROK_SUBSCRIPTION_PROVIDER: SubscriptionProvider = Object.freeze({
  displayName: 'Grok',
  buildStatusMessage: () =>
    buildAuthStatusMessage(
      SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS,
      getGrokAuthStatus,
    ),
  signIn: async (channel: string) => {
    await signInWithGrokSubscription(channel);
  },
  signOut: () => xaiCoordinator().signOut(),
  setPreferSubscription: setPreferXaiSubscription,
});
