// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'RecentCommits';
logger.initialize(CHANNEL);

interface RecentCommitOptions {
  notifyWhenEmpty?: boolean;
}

export async function fetchRecentCommits(
  options: RecentCommitOptions = {},
): Promise<{ commits: string[]; isGitRepo: boolean }> {
  const isGitRepo = await vscode.commands.executeCommand<boolean>(
    'texra.isGitRepository',
  );
  const commits = isGitRepo
    ? await vscode.commands.executeCommand<string[]>('texra.getRecentCommits')
    : [];

  if (options.notifyWhenEmpty && (commits.length === 0 || !isGitRepo)) {
    const infoMessage = isGitRepo
      ? 'No recent commits found for this repository.'
      : 'This workspace is not a Git repository.';
    logger.info(CHANNEL, infoMessage);
    vscode.window.showInformationMessage(infoMessage);
  }

  return { commits, isGitRepo: Boolean(isGitRepo) };
}
