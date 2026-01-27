import * as vscode from 'vscode';

import { mainViewMessages } from '@shared/schemas';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
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
    this.runDiffCommand(parsed.data.command, parsed.data, [
      'inputFile',
      'baseFile',
      'editedFile',
    ]);
  }

  handleLatexdiffvc(message: unknown): void {
    const parsed = mainViewMessages.LatexdiffvcMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn(CHANNEL, 'Invalid latexdiffvc message', {
        data: parsed.error,
      });
      return;
    }
    this.runDiffCommand(parsed.data.command, parsed.data, [
      'inputFile',
      'baseFile',
      'commitHash',
    ]);
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
    this.runDiffCommand(parsed.data.command, parsed.data, [
      'inputFile',
      'baseFile',
      'commitHash',
      'clean',
    ]);
  }

  private runDiffCommand(
    command: string,
    message: Record<string, unknown>,
    paramKeys: string[],
  ): void {
    void vscode.commands.executeCommand(
      `texra.${command}`,
      ...paramKeys.map((k) => message[k]),
    );
  }

  private async fetchRecentCommits(): Promise<{
    commits: string[];
    isGitRepo: boolean;
  }> {
    const isGitRepo = await vscode.commands.executeCommand<boolean>(
      'texra.isGitRepository',
    );
    if (!isGitRepo) {
      return { commits: [], isGitRepo: false };
    }
    const commits = await vscode.commands.executeCommand<string[]>(
      'texra.getRecentCommits',
    );
    return { commits, isGitRepo: true };
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
    const result = await this.fetchRecentCommits();

    const shouldNotify =
      parsed.data.notifyWhenEmpty &&
      (result.commits.length === 0 || !result.isGitRepo);
    if (shouldNotify) {
      const infoMessage = result.isGitRepo
        ? 'No recent commits found for this repository.'
        : 'This workspace is not a Git repository.';
      logger.info(CHANNEL, infoMessage);
      vscode.window.showInformationMessage(infoMessage);
    }

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      ...result,
    });
  }

  async handleRefreshCommits(): Promise<void> {
    const result = await this.fetchRecentCommits();
    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      ...result,
    });
  }
}
