// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import * as logger from '@logger/logUtils';
import { BaseWebviewManager } from './BaseWebviewManager';

const CHANNEL = 'DiffManager';
logger.initialize(CHANNEL);

export class DiffManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  handleLatexdiff(message: any): void {
    this.runDiffCommand('latexdiff', message, [
      'inputFile',
      'baseFile',
      'editedFile',
    ]);
  }

  handleLatexdiffvc(message: any): void {
    this.runDiffCommand('latexdiffvc', message, [
      'inputFile',
      'baseFile',
      'commitHash',
    ]);
  }

  handleLatexdiffvcOperation(message: any): void {
    this.runDiffCommand(message.command, message, [
      'inputFile',
      'baseFile',
      'commitHash',
      'clean',
    ]);
  }

  private runDiffCommand(
    command: string,
    message: any,
    paramKeys: string[],
  ): void {
    void vscode.commands.executeCommand(
      `texra.${command}`,
      ...paramKeys.map((k) => message[k]),
    );
  }

  private async _fetchRecentCommits(): Promise<{
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

  async handleRequestRecentCommits(message: any): Promise<void> {
    const result = await this._fetchRecentCommits();

    // Notify user when empty if requested
    const shouldNotify =
      message?.notifyWhenEmpty &&
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
    const result = await this._fetchRecentCommits();
    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      ...result,
    });
  }
}
