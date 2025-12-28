// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import * as logger from '@logger/logUtils';

const CHANNEL = 'DiffManager';
logger.initialize(CHANNEL);

export class DiffManager {
  handleLatexdiff(message: any): void {
    void vscode.commands.executeCommand(
      'texra.latexdiff',
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleLatexdiffvc(message: any): void {
    void vscode.commands.executeCommand(
      'texra.latexdiffvc',
      message.inputFile,
      message.baseFile,
      message.commitHash,
    );
  }

  handleLatexdiffvcOperation(message: any): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.commitHash,
      message.clean,
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

  async handleRequestRecentCommits(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const result = await this._fetchRecentCommits();
    this._notifyWhenEmpty(message, result);
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      ...result,
    });
  }

  async handleRefreshCommits(webviewView: vscode.WebviewView): Promise<void> {
    const result = await this._fetchRecentCommits();
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      ...result,
    });
  }

  private _notifyWhenEmpty(
    message: any,
    result: { commits: string[]; isGitRepo: boolean },
  ): void {
    if (!message?.notifyWhenEmpty) {
      return;
    }

    if (result.commits.length === 0 || !result.isGitRepo) {
      const infoMessage = result.isGitRepo
        ? 'No recent commits found for this repository.'
        : 'This workspace is not a Git repository.';

      logger.info(CHANNEL, infoMessage);
      vscode.window.showInformationMessage(infoMessage);
    }
  }
}
