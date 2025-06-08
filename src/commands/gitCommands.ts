// Standard library imports
import spawn from 'cross-spawn';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '../utils/configUtils';
import { getWorkspacePath } from '../utils/workspaceFileUtils';

export function registerGitCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.isGitRepository', isGitRepository),
    vscode.commands.registerCommand('texra.getRecentCommits', getRecentCommits),
  );
}

async function isGitRepository(): Promise<boolean> {
  const workspacePath = getWorkspacePath();
  if (workspacePath) {
    const result = spawn.sync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspacePath,
    });
    return result.status === 0;
  }
  return false;
}

async function getRecentCommits(): Promise<string[] | null> {
  const isGitRepo = await isGitRepository();
  if (!isGitRepo) {
    return null;
  }

  const workspacePath = getWorkspacePath();
  if (workspacePath) {
    const numberOfCommits = getConfig('git.numberOfCommitsToShow', 20);
    const result = spawn.sync(
      'git',
      ['log', '-n', String(numberOfCommits), '--pretty=format:%h: %s (%cr)'],
      { cwd: workspacePath },
    );
    if (result.status !== 0) {
      return [];
    }
    return result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim());
  }
  return [];
}

export const gitCommands = {
  isGitRepository,
  getRecentCommits,
};
