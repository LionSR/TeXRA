import * as vscode from 'vscode';

import { mainViewMessages } from '@shared/schemas';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { fetchRecentCommits } from '@frontend/git/recentCommits';
import * as logger from '@logger/logUtils';

import { BaseWebviewManager } from './BaseWebviewManager';

const CHANNEL = 'DiffManager';
logger.initialize(CHANNEL);

export class DiffManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  handleLatexdiff(message: unknown): void {
    const parsed = mainViewMessages.LatexdiffMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn(CHANNEL, 'Invalid latexdiff message', {
        data: parsed.error,
      });
      return;
    }
    void vscode.commands.executeCommand(
      `texra.${parsed.data.command}`,
      parsed.data.inputFile,
      parsed.data.baseFile,
      parsed.data.editedFile,
    );
  }

  handleLatexdiffvc(message: unknown): void {
    const parsed = mainViewMessages.LatexdiffvcMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn(CHANNEL, 'Invalid latexdiffvc message', {
        data: parsed.error,
      });
      return;
    }
    void vscode.commands.executeCommand(
      `texra.${parsed.data.command}`,
      parsed.data.inputFile,
      parsed.data.baseFile,
      parsed.data.commitHash,
    );
  }

  handleLatexdiffvcOperation(message: unknown): void {
    const parsed =
      mainViewMessages.LatexdiffvcOperationMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn(CHANNEL, 'Invalid latexdiffvc operation message', {
        data: parsed.error,
      });
      return;
    }
    void vscode.commands.executeCommand(
      `texra.${parsed.data.command}`,
      parsed.data.inputFile,
      parsed.data.baseFile,
      parsed.data.commitHash,
      parsed.data.clean,
    );
  }

  async handleRequestRecentCommits(message: unknown): Promise<void> {
    const parsed =
      mainViewMessages.RequestRecentCommitsMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn(CHANNEL, 'Invalid request recent commits message', {
        data: parsed.error,
      });
      return;
    }

    const { commits, isGitRepo } = await fetchRecentCommits({
      // Convert null to undefined (schema uses .nullish(), function expects boolean | undefined)
      notifyWhenEmpty: parsed.data.notifyWhenEmpty ?? undefined,
    });

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits,
      isGitRepo: Boolean(isGitRepo),
    });
  }

  async handleRefreshCommits(): Promise<void> {
    const { commits, isGitRepo } = await fetchRecentCommits();

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits,
      isGitRepo: Boolean(isGitRepo),
    });
  }
}
