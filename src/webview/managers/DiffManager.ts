// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview

// Local imports - commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'DiffManager';
logger.initialize(CHANNEL);

export class DiffManager {
  handleLatexdiff(message: any): void {
    vscode.commands.executeCommand(
      'texra.latexdiff',
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleLatexdiffvc(message: any): void {
    vscode.commands.executeCommand(
      'texra.latexdiffvc',
      message.inputFile,
      message.baseFile,
      message.commitHash,
    );
  }

  handleLatexdiffvcOperation(message: any): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.commitHash,
      message.clean,
    );
  }

  async handleRequestRecentCommits(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const isGitRepo = await vscode.commands.executeCommand<boolean>(
      'texra.isGitRepository',
    );
    const commits = isGitRepo
      ? await vscode.commands.executeCommand<string[]>('texra.getRecentCommits')
      : [];
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits,
      isGitRepo,
    });
  }

  async handleRefreshCommits(webviewView: vscode.WebviewView): Promise<void> {
    const isGitRepoRefresh = await vscode.commands.executeCommand<boolean>(
      'texra.isGitRepository',
    );
    if (isGitRepoRefresh) {
      const commitsRefresh = await vscode.commands.executeCommand<string[]>(
        'texra.getRecentCommits',
      );
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
        commits: commitsRefresh,
      });
    } else {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
        isGitRepo: false,
      });
    }
  }
}
