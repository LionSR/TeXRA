// Standard library imports
import { execaSync } from 'execa';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

const COMMIT_LABEL_FORMAT = '%h: %s (%cr)';

export function registerGitCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.isGitRepository', isGitRepository),
    vscode.commands.registerCommand('texra.getRecentCommits', getRecentCommits),
    vscode.commands.registerCommand(
      'texra.findCommitInHistory',
      findCommitInHistory,
    ),
  );
}

async function isGitRepository(): Promise<boolean> {
  const workspacePath = WorkspaceFS.getPath();
  if (workspacePath) {
    const result = execaSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspacePath,
      reject: false,
    });
    return result.exitCode === 0;
  }
  return false;
}

async function getRecentCommits(): Promise<string[] | null> {
  const isGitRepo = await isGitRepository();
  if (!isGitRepo) {
    return null;
  }

  const workspacePath = WorkspaceFS.getPath();
  if (workspacePath) {
    const numberOfCommits = getConfig('git.numberOfCommitsToShow', 20);

    // Validate numberOfCommits to prevent injection
    if (
      typeof numberOfCommits !== 'number' ||
      numberOfCommits <= 0 ||
      numberOfCommits > 1000
    ) {
      throw new Error(
        'Invalid numberOfCommits value. It must be a positive integer between 1 and 1000.',
      );
    }

    const result = execaSync(
      'git',
      [
        'log',
        '-n',
        numberOfCommits.toString(),
        `--pretty=format:${COMMIT_LABEL_FORMAT}`,
      ],
      { cwd: workspacePath, reject: false },
    );
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim());
  }
  return [];
}

async function findCommitInHistory(commitHash: string): Promise<string | null> {
  if (typeof commitHash !== 'string') {
    return null;
  }

  const sanitizedCommit = commitHash.trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(sanitizedCommit)) {
    return null;
  }

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return null;
  }

  const verifyResult = execaSync(
    'git',
    ['rev-parse', '--verify', `${sanitizedCommit}^{commit}`],
    { cwd: workspacePath, reject: false },
  );

  if (verifyResult.exitCode !== 0) {
    return null;
  }

  const labelResult = execaSync(
    'git',
    ['show', '-s', `--format=${COMMIT_LABEL_FORMAT}`, sanitizedCommit],
    { cwd: workspacePath, reject: false },
  );

  if (labelResult.exitCode !== 0) {
    return sanitizedCommit;
  }

  const label = labelResult.stdout.toString().trim();
  return label || sanitizedCommit;
}

export const gitCommands = {
  isGitRepository,
  getRecentCommits,
  findCommitInHistory,
};
