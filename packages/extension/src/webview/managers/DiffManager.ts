import * as vscode from 'vscode';

import { createLog } from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type {
  LatexdiffMessage,
  LatexdiffvcMessage,
  LatexdiffvcOperationMessage,
  MainViewMessage,
} from '@shared/schemas';

export class DiffManager {
  private readonly channel = 'DiffManager';
  private readonly log = createLog(this.channel);

  /** Posts to whichever launcher webview is dispatching right now. */
  constructor(private readonly post: (message: MainViewMessage) => void) {}

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

  async postRecentCommits(notifyWhenEmpty?: boolean): Promise<void> {
    const isGitRepo =
      (await vscode.commands.executeCommand<boolean>(
        'texra.isGitRepository',
      )) ?? false;
    const commits = isGitRepo
      ? ((await vscode.commands.executeCommand<string[]>(
          'texra.getRecentCommits',
        )) ?? [])
      : [];

    if (notifyWhenEmpty && commits.length === 0) {
      const infoMessage = isGitRepo
        ? 'No recent commits found for this repository.'
        : 'This workspace is not a Git repository.';
      this.log.info(infoMessage);
      void vscode.window.showInformationMessage(infoMessage);
    }

    this.post({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits,
      isGitRepo,
    });
  }
}
