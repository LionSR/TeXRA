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
import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';
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

/** GitHub token and subscription handler delegate. */
export class GitHubSubscriptionHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly secrets: PlatformSecrets,
  ) {}

  sendGitHubTokenStatus(webview: vscode.Webview) {
    return Effect.flatMap(resolveGitHubTokenSource(this.secrets), (status) =>
      postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
        status,
      }),
    );
  }

  handleSetGitHubToken() {
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

  handleRemoveGitHubToken() {
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

  openGitHubTokenUrl() {
    return Effect.promise(() =>
      vscode.env.openExternal(vscode.Uri.parse(GITHUB_TOKEN_CREATE_URL)),
    ).pipe(Effect.asVoid);
  }

  sendPRSubscriptions(webview: vscode.Webview) {
    return postToWebview(webview, {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: listGitHubSubscriptionEntries(getProgressRunLabel),
    });
  }

  handleUnsubscribePR(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.UNSUBSCRIBE_PR>,
  ): void {
    const removed = unsubscribeGitHubKey(data.key);
    if (removed === 0) {
      void vscode.window.showInformationMessage(
        noActiveGitHubSubscriptionMessage(data.key),
      );
    }
  }

  handleOpenPRSubscriptionStream(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_CMD.OPEN_PR_SUBSCRIPTION_STREAM
    >,
  ) {
    return Effect.gen({ self: this }, function* () {
      const result = yield* Effect.promise(() => revealProgressRun(data.runId));
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
