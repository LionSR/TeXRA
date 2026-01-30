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
    const data = this.parseMessage(
      mainViewMessages.LatexdiffMessageSchema,
      message,
      'latexdiff',
    );
    if (!data) return;
    void vscode.commands.executeCommand(
      `texra.${data.command}`,
      data.inputFile,
      data.baseFile,
      data.editedFile,
    );
  }

  handleLatexdiffvc(message: unknown): void {
    const data = this.parseMessage(
      mainViewMessages.LatexdiffvcMessageSchema,
      message,
      'latexdiffvc',
    );
    if (!data) return;
    void vscode.commands.executeCommand(
      `texra.${data.command}`,
      data.inputFile,
      data.baseFile,
      data.commitHash,
    );
  }

  handleLatexdiffvcOperation(message: unknown): void {
    const data = this.parseMessage(
      mainViewMessages.LatexdiffvcOperationMessageSchema,
      message,
      'latexdiffvc operation',
    );
    if (!data) return;
    void vscode.commands.executeCommand(
      `texra.${data.command}`,
      data.inputFile,
      data.baseFile,
      data.commitHash,
      data.clean,
    );
  }

  /** Parse message with schema, logging warning on failure */
  private parseMessage<T>(
    schema: {
      safeParse: (
        data: unknown,
      ) => { success: true; data: T } | { success: false; error: unknown };
    },
    message: unknown,
    context: string,
  ): T | null {
    const result = schema.safeParse(message);
    if (!result.success) {
      logger.warn(CHANNEL, `Invalid ${context} message`, {
        data: result.error,
      });
      return null;
    }
    return result.data;
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

    // Convert null to undefined (schema uses .nullish(), function expects boolean | undefined)
    await this.postRecentCommits(parsed.data.notifyWhenEmpty ?? undefined);
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
