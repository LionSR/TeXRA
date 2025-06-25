// Third-party imports
import * as vscode from 'vscode';

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
      command: 'setRecentCommits',
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
        command: 'setRecentCommits',
        commits: commitsRefresh,
      });
    } else {
      webviewView.webview.postMessage({
        command: 'setRecentCommits',
        isGitRepo: false,
      });
    }
  }
}
