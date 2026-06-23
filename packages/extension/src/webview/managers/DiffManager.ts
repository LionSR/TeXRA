import * as vscode from 'vscode';

import { fetchRecentCommits } from '@frontend/git/recentCommits';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type {
  LatexdiffMessage,
  LatexdiffvcMessage,
  LatexdiffvcOperationMessage,
  RequestRecentCommitsMessage,
} from '@shared/schemas';

import { BaseWebviewManager } from './BaseWebviewManager';

export class DiffManager extends BaseWebviewManager {
  protected readonly channel = 'DiffManager';

  handleLatexdiff(message: LatexdiffMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleLatexdiffvc(message: LatexdiffvcMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.commitHash,
    );
  }

  handleLatexdiffvcOperation(message: LatexdiffvcOperationMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.commitHash,
      message.clean,
    );
  }

  async handleRequestRecentCommits(
    message: RequestRecentCommitsMessage,
  ): Promise<void> {
    await this.postRecentCommits(message.notifyWhenEmpty ?? undefined);
  }

  async handleRefreshCommits(): Promise<void> {
    await this.postRecentCommits();
  }

  private async postRecentCommits(notifyWhenEmpty?: boolean): Promise<void> {
    const { commits, isGitRepo } = await fetchRecentCommits({
      notifyWhenEmpty,
    });

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits,
      isGitRepo: Boolean(isGitRepo),
    });
  }
}
