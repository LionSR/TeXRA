// Third-party imports
import * as vscode from 'vscode';

// Local imports - logger
import * as logger from '@logger/logUtils';

const CHANNEL = 'recentCommits';

export interface RecentCommitsResult {
  commits: string[];
  isGitRepo: boolean;
}

export async function fetchRecentCommits(
  options: { notifyWhenEmpty?: boolean } = {},
): Promise<RecentCommitsResult> {
  const isGitRepo =
    (await vscode.commands.executeCommand<boolean>('texra.isGitRepository')) ??
    false;
  const commits = isGitRepo
    ? ((await vscode.commands.executeCommand<string[]>(
        'texra.getRecentCommits',
      )) ?? [])
    : [];

  if (options.notifyWhenEmpty && (commits.length === 0 || !isGitRepo)) {
    const infoMessage = isGitRepo
      ? 'No recent commits found for this repository.'
      : 'This workspace is not a Git repository.';
    logger.info(CHANNEL, infoMessage);
    void vscode.window.showInformationMessage(infoMessage);
  }

  return { commits, isGitRepo };
}
