/**
 * Subscription sign-in handlers for Settings → Subscriptions.
 *
 * ChatGPT (Codex) and Grok (xAI) run the identical flow: a host-neutral OAuth
 * sign-in, a sign-out through the provider's auth coordinator, a routing
 * preference write, and a status round-trip back to the settings webview after
 * each. Everything provider-specific except the outbound wire message comes
 * from the shared `SUBSCRIPTION_PROVIDERS` catalog, so this file configures a
 * provider by id plus its status-message program.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import {
  subscriptionProvider,
  type SubscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type {
  UpdateChatGptAuthStatusMessage,
  UpdateGrokAuthStatusMessage,
} from '@shared/schemas';
import { ACCOUNT_OUTCOME } from '@shared/copy/accountAuth';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { allSettledVoid } from '@utils/core/allSettledVoid';

import {
  postToWebview,
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
    /**
     * Current sign-in status, already wrapped as its outbound wire message:
     * the read as the program it is, re-run on every post.
     */
    private readonly statusMessage: Effect.Effect<
      SubscriptionAuthStatusMessage,
      never,
      ProcessServices
    >,
    private readonly ctx: SettingsHandlerContext,
    private readonly secrets: PlatformSecrets,
    private readonly refreshModelAccess: () => Effect.Effect<
      void,
      Error,
      ProcessServices
    >,
    /**
     * Settles the sign-in flow's progress notification, which VS Code hands a
     * promise.
     */
    private readonly runtime: ProcessRuntime,
    /** The view's session setting slots: where the preference is read and written. */
    private readonly stores: SettingsStores,
  ) {
    this.provider = subscriptionProvider(providerId);
  }

  sendAuthStatus(webview: vscode.Webview) {
    return Effect.flatMap(this.statusMessage, (message) =>
      postToWebview(webview, message),
    );
  }

  private refreshState() {
    return allSettledVoid([
      this.ctx.withActiveWebview((w) => this.sendAuthStatus(w)),
      this.refreshModelAccess(),
    ]);
  }

  readonly handleSignIn = () =>
    signInWithSubscription(
      this.stores,
      this.ctx.channel,
      this.providerId,
      this.runtime,
    ).pipe(Effect.andThen(this.refreshState()));

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
   * Apply the subscription preference, warn when a more specific setting
   * overrides the requested value, log failures, and always refresh the
   * settings view.
   */
  handleSetPreferSubscription(enabled: boolean) {
    const { displayName } = this.provider;
    return withHandlerErrorHandling(
      this.ctx,
      `Could not update the ${displayName} subscription preference`,
      Effect.map(
        this.provider.setPreferSubscription(this.stores, enabled),
        (update) => {
          if (update.effective !== enabled) {
            void vscode.window.showWarningMessage(
              `A more specific setting still keeps ${displayName} subscription ${update.effective ? 'enabled' : 'disabled'}.`,
            );
          }
        },
      ),
    ).pipe(Effect.andThen(this.refreshState()));
  }
}
