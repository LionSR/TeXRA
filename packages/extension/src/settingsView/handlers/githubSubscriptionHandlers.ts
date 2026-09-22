/**
 * GitHub token and PR/repo/issue subscription handlers.
 *
 * Handles the GitHub personal access token secret plus the live list of
 * PR/repo/issue subscriptions surfaced in the Git tab, including revealing
 * a subscription's agent stream in the Progress view.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import { storeCredential } from '@common/secrets/storeCredential';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import {
  listGitHubSubscriptionEntries,
  noActiveGitHubSubscriptionMessage,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import type { PlatformSecrets } from '@platform/secrets';
import {
  getProgressRunLabel,
  revealProgressRun,
} from '@progressView/progressNavigation';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/settingsView/settingsViewMessages';
import {
  GITHUB_TOKEN_CREATE_URL,
  GITHUB_TOKEN_PROMPT,
  GITHUB_TOKEN_REMOVED_MESSAGE,
  GITHUB_TOKEN_SAVED_MESSAGE,
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import {
  postToWebview,
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** The Git tab's inbound arms, spread into the settings-view registry. */
type GitTabHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_CMD.GET_GITHUB_TOKEN_STATUS
  | typeof SETTINGS_VIEW_CMD.SET_GITHUB_TOKEN
  | typeof SETTINGS_VIEW_CMD.REMOVE_GITHUB_TOKEN
  | typeof SETTINGS_VIEW_CMD.OPEN_GITHUB_TOKEN_URL
  | typeof SETTINGS_VIEW_CMD.GET_PR_SUBSCRIPTIONS
  | typeof SETTINGS_VIEW_CMD.UNSUBSCRIBE_PR
  | typeof SETTINGS_VIEW_CMD.OPEN_PR_SUBSCRIPTION_STREAM
>;

/** GitHub token and subscription handler delegate. */
export class GitHubSubscriptionHandlers {
  readonly handlers: GitTabHandlers;

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly secrets: PlatformSecrets,
  ) {
    // Each arm is a settings-view message, so its program settles on the
    // view's boundary here rather than in the view's own registry.
    this.handlers = {
      getGitHubTokenStatus: () =>
        ctx.withActiveWebview((w) => this.sendGitHubTokenStatus(w)),
      setGitHubToken: () => this.handleSetGitHubToken(),
      removeGitHubToken: () => this.handleRemoveGitHubToken(),
      openGitHubTokenUrl: () => this.openGitHubTokenUrl(),
      getPRSubscriptions: () =>
        ctx.withActiveWebview((w) => this.sendPRSubscriptions(w)),
      unsubscribePR: (message) => this.handleUnsubscribePR(message),
      openPRSubscriptionStream: (message) =>
        this.handleOpenPRSubscriptionStream(message),
    };
  }

  sendGitHubTokenStatus(webview: vscode.Webview) {
    return Effect.flatMap(resolveGitHubTokenSource(this.secrets), (status) =>
      postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
        status,
      }),
    );
  }

  private handleSetGitHubToken() {
    return Effect.gen({ self: this }, function* () {
      const token = yield* Effect.promise(() =>
        vscode.window.showInputBox({
          prompt: GITHUB_TOKEN_PROMPT,
          password: true,
          placeHolder: 'ghp_…',
          ignoreFocusOut: true,
        }),
      );
      if (token == null) return;
      yield* withHandlerErrorHandling(
        this.ctx,
        'Failed to save GitHub token',
        Effect.gen({ self: this }, function* () {
          yield* storeCredential(this.secrets, {
            secretName: GITHUB_TOKEN_STORAGE_KEY,
            value: token,
            kind: 'github',
          });
          void vscode.window.showInformationMessage(GITHUB_TOKEN_SAVED_MESSAGE);
          yield* this.ctx.withActiveWebview((w) =>
            this.sendGitHubTokenStatus(w),
          );
        }),
      );
    });
  }

  private handleRemoveGitHubToken() {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to remove GitHub token',
      Effect.gen({ self: this }, function* () {
        yield* this.secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
        void vscode.window.showInformationMessage(GITHUB_TOKEN_REMOVED_MESSAGE);
        yield* this.ctx.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
      }),
    );
  }

  private openGitHubTokenUrl() {
    return Effect.promise(() =>
      vscode.env.openExternal(vscode.Uri.parse(GITHUB_TOKEN_CREATE_URL)),
    ).pipe(Effect.asVoid);
  }

  sendPRSubscriptions(webview: vscode.Webview) {
    return Effect.flatMap(
      listGitHubSubscriptionEntries(getProgressRunLabel),
      (subscriptions) =>
        postToWebview(webview, {
          command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
          subscriptions,
        }),
    );
  }

  private handleUnsubscribePR(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.UNSUBSCRIBE_PR>,
  ) {
    return Effect.gen(function* () {
      const removed = yield* unsubscribeGitHubKey(data.key);
      if (removed === 0) {
        void vscode.window.showInformationMessage(
          noActiveGitHubSubscriptionMessage(data.key),
        );
      }
    });
  }

  private handleOpenPRSubscriptionStream(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_CMD.OPEN_PR_SUBSCRIPTION_STREAM
    >,
  ) {
    return Effect.gen({ self: this }, function* () {
      const result = yield* revealProgressRun(data.runId);
      if (result === 'unavailable') {
        yield* showLoggedMessage(
          this.ctx.channel,
          'Progress View is not available. Please try again.',
        );
        return;
      }

      if (result === 'missing') {
        yield* Effect.promise(() =>
          vscode.window.showWarningMessage(
            'The agent run is no longer available.',
          ),
        );
      }
    });
  }
}
