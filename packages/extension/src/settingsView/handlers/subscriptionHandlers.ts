/**
 * Subscription sign-in handlers for the Settings → Models page.
 *
 * ChatGPT (Codex) and Grok (xAI) run the identical flow: a host-neutral OAuth
 * sign-in, a sign-out through the provider's auth coordinator, a routing
 * preference write, and a status round-trip back to the settings webview after
 * each. Everything provider-specific comes from the shared
 * `SUBSCRIPTION_PROVIDERS` catalog and the one provider-keyed status message,
 * so this file configures a provider by id alone.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import { subscriptionAuthStatus } from '@controllers/modelAccess/subscriptionAuthStatus';
import {
  subscriptionProvider,
  type SubscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import type { ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { allSettledVoid } from '@utils/core/allSettledVoid';

import {
  postToWebview,
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Subscription sign-in handler delegate for one provider. */
export class SubscriptionHandlers {
  private readonly provider: SubscriptionProvider;

  constructor(
    private readonly providerId: SubscriptionProviderId,
    private readonly ctx: SettingsHandlerContext,
    private readonly secrets: PlatformSecrets,
    private readonly refreshModelAccess: () => Effect.Effect<
      void,
      Error,
      ProcessServices
    >,
    /** The view's session setting slots: where the preference is read and written. */
    private readonly stores: SettingsStores,
  ) {
    this.provider = subscriptionProvider(providerId);
  }

  /** The status read as the program it is, re-run on every post. */
  sendAuthStatus(webview: vscode.Webview) {
    return Effect.flatMap(
      subscriptionAuthStatus(this.providerId, this.stores, this.secrets),
      (status) =>
        postToWebview(webview, {
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_AUTH_STATUS,
          status,
        }),
    );
  }

  private refreshState() {
    return allSettledVoid([
      this.ctx.withActiveWebview((w) => this.sendAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  readonly handleSignIn = () =>
    signInWithSubscription(this.stores, this.ctx.channel, this.providerId).pipe(
      Effect.andThen(this.refreshState()),
    );

  handleSignOut() {
    const { displayName } = this.provider;
    return withHandlerErrorHandling(
      this.ctx,
      ACCOUNT_OUTCOME.signOutFailed(displayName),
      Effect.gen({ self: this }, function* () {
        yield* this.provider.signOut(this.secrets);
        void vscode.window.showInformationMessage(
          ACCOUNT_OUTCOME.signedOut(displayName),
        );
        yield* this.refreshState();
      }),
    );
  }

  /**
   * Apply the subscription preference, log failures, and always refresh the
   * settings view.
   */
  handleSetPreferSubscription(enabled: boolean) {
    const { displayName } = this.provider;
    return withHandlerErrorHandling(
      this.ctx,
      `Could not update the ${displayName} subscription preference`,
      this.provider.setPreferSubscription(this.stores, enabled),
    ).pipe(Effect.andThen(this.refreshState()));
  }
}
