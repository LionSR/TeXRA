// Standard library imports
import { exec } from 'child_process';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '../frontend-utils/commonUtils';
import { getWorkspacePath } from '../utils/workspaceFileUtils';

export function registerGitCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.isGitRepository',
      isGitRepository,
    ),
    vscode.commands.registerCommand(
      'coauthor.getRecentCommits',
      getRecentCommits,
    ),
  );
}

async function isGitRepository(): Promise<boolean> {
  const workspacePath = getWorkspacePath();
  if (workspacePath) {
    return new Promise<boolean>((resolve) => {
      exec(
        'git rev-parse --is-inside-work-tree',
        { cwd: workspacePath },
        (error) => {
          resolve(!error);
        },
      );
    });
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
    return new Promise<string[]>((resolve, reject) => {
      exec(
        `git log -n ${numberOfCommits} --pretty=format:"%h: %s (%cr)"`,
        { cwd: workspacePath },
        (error, stdout, stderr) => {
          if (error) {
            reject(stderr);
          } else {
            const commits = stdout.split('\n').map((line) => line.trim());
            resolve(commits);
          }
        },
      );
    });
  }
  return [];
}

export const gitCommands = {
  isGitRepository,
  getRecentCommits,
};
