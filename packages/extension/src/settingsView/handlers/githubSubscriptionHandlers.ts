/**
 * GitHub token and PR/repo/issue subscription handlers.
 *
 * Handles the GitHub personal access token secret plus the live list of
 * PR/repo/issue subscriptions surfaced in the Git tab, including revealing
 * a subscription's agent stream in the Progress view.
 */
import * as vscode from 'vscode';

import { SecretManager } from '@frontend/secretManager';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  getProgressStreamLabel,
  revealProgressStream,
} from '@progressView/progressNavigation';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';
import {
  issuePollingSource,
  listIssueSubscriptionBindings,
  listPRSubscriptionBindings,
  listRepoSubscriptionBindings,
  prPollingSource,
  repoPollingSource,
  unbindAllForIssue,
  unbindAllForPR,
  unbindAllForRepo,
} from '@tools/github';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

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
    if (!token) return;
    try {
      await SecretManager.set(SecretManager.GITHUB_TOKEN_KEY, token.trim());
      void vscode.window.showInformationMessage('GitHub token saved.');
      await this.ctx.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to save GitHub token',
        error,
      );
    }
  }

  async handleRemoveGitHubToken(): Promise<void> {
    try {
      await SecretManager.delete(SecretManager.GITHUB_TOKEN_KEY);
      void vscode.window.showInformationMessage('GitHub token removed.');
      await this.ctx.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to remove GitHub token',
        error,
      );
    }
  }

  async openGitHubTokenUrl(): Promise<void> {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        'https://github.com/settings/tokens/new?description=TeXRA%20PR%20subscription&scopes=repo',
      ),
    );
  }

  async sendPRSubscriptions(webview: vscode.Webview): Promise<void> {
    const toEntry = (binding: {
      key: string;
      streamIds: readonly string[];
    }): { key: string; owners: { streamId: string; label: string }[] } => ({
      key: binding.key,
      owners: binding.streamIds.map((streamId) => ({
        streamId,
        label: getProgressStreamLabel(streamId) ?? streamId,
      })),
    });

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: [
        ...listPRSubscriptionBindings(prPollingSource.activeKeys()).map(
          toEntry,
        ),
        ...listRepoSubscriptionBindings(repoPollingSource.activeKeys()).map(
          toEntry,
        ),
        ...listIssueSubscriptionBindings(issuePollingSource.activeKeys()).map(
          toEntry,
        ),
      ],
    });
  }

  handleUnsubscribePR(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.UNSUBSCRIBE_PR>,
  ): void {
    // Path form mirrors GitHub's REST URL shape:
    //   owner/repo               → repo
    //   owner/repo/pulls/N       → PR
    //   owner/repo/issues/N      → issue
    const k = data.key;
    let removed: number;
    if (k.includes('/pulls/')) {
      removed = unbindAllForPR(k);
    } else if (k.includes('/issues/')) {
      removed = unbindAllForIssue(k);
    } else {
      removed = unbindAllForRepo(k);
    }
    if (removed === 0) {
      void vscode.window.showInformationMessage(
        `No active subscription for ${k}.`,
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
