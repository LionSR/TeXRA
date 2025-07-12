// Standard library imports
import { execaCommandSync } from 'execa';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

export function registerGitCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.isGitRepository', isGitRepository),
    vscode.commands.registerCommand('texra.getRecentCommits', getRecentCommits),
  );
}

async function isGitRepository(): Promise<boolean> {
  const workspacePath = WorkspaceFS.getPath();
  if (workspacePath) {
    const result = execaCommandSync('git rev-parse --is-inside-work-tree', {
      cwd: workspacePath,
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
    const result = execaCommandSync(
      `git log -n ${numberOfCommits} --pretty=format:%h: %s (%cr)`,
      { cwd: workspacePath },
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

export const gitCommands = {
  isGitRepository,
  getRecentCommits,
};
