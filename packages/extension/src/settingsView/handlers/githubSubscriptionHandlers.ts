/**
 * GitHub token and PR/repo/issue subscription handlers.
 *
 * Handles the GitHub personal access token secret plus the live list of
 * PR/repo/issue subscriptions surfaced in the Git tab, including revealing
 * a subscription's agent stream in the Progress view.
 */
import * as vscode from 'vscode';

import {
  listGitHubSubscriptionEntries,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import { SecretManager } from '@frontend/secretManager';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { platform } from '@platform/platform';
import {
  getProgressStreamLabel,
  revealProgressStream,
} from '@progressView/progressNavigation';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';
import {
  GITHUB_TOKEN_CREATE_URL,
  GITHUB_TOKEN_STORAGE_KEY,
} from '@tools/github/githubAuth';
import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** GitHub token and subscription handler delegate. */
export class GitHubSubscriptionHandlers {
  constructor(private readonly ctx: SettingsHandlerContext) {}

  async sendGitHubTokenStatus(webview: vscode.Webview): Promise<void> {
    const status = await SecretManager.gitHubTokenExists();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status,
    });
  }

  async handleSetGitHubToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      prompt:
        'Paste a GitHub personal access token (repo or public_repo scope)',
      password: true,
      placeHolder: 'ghp_…',
      ignoreFocusOut: true,
    });
    const trimmed = token?.trim();
    if (!trimmed) return;
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to save GitHub token',
      async () => {
        await platform().secrets.set(GITHUB_TOKEN_STORAGE_KEY, trimmed);
        void vscode.window.showInformationMessage('GitHub token saved.');
        await this.ctx.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
      },
    );
  }

  async handleRemoveGitHubToken(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to remove GitHub token',
      async () => {
        await platform().secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
        void vscode.window.showInformationMessage('GitHub token removed.');
        await this.ctx.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
      },
    );
  }

  async openGitHubTokenUrl(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(GITHUB_TOKEN_CREATE_URL));
  }

  async sendPRSubscriptions(webview: vscode.Webview): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: listGitHubSubscriptionEntries(getProgressStreamLabel),
    });
  }

  handleUnsubscribePR(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.UNSUBSCRIBE_PR>,
  ): void {
    const removed = unsubscribeGitHubKey(data.key);
    if (removed === 0) {
      void vscode.window.showInformationMessage(
        `No active subscription for ${data.key}.`,
      );
    }
  }

  async handleOpenPRSubscriptionStream(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_CMD.OPEN_PR_SUBSCRIPTION_STREAM
    >,
  ): Promise<void> {
    const result = await revealProgressStream(data.streamId);
    if (result === 'unavailable') {
      await showLoggedMessage(
        this.ctx.channel,
        'Progress View is not available. Please try again.',
      );
      return;
    }

    if (result === 'missing') {
      await vscode.window.showWarningMessage(
        'The agent stream is no longer available.',
      );
    }
  }
}
