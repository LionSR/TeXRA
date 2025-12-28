// Standard library imports
import { promises as fs } from 'fs';

// Third-party imports
import { execa, execaSync } from 'execa';
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { logger } from '@logger/logUtils';

// Type imports
import type { Dirent } from 'fs';

const COMMIT_LABEL_FORMAT = '%h: %s (%cr)';

export function registerGitCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.isGitRepository', isGitRepository),
    vscode.commands.registerCommand('texra.getRecentCommits', getRecentCommits),
    vscode.commands.registerCommand(
      'texra.findCommitInHistory',
      findCommitInHistory,
    ),
    vscode.commands.registerCommand('texra.cloneOverleafProject', () =>
      cloneOverleafProject(context),
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
    const numberOfCommits = getConfig('texra.git.numberOfCommitsToShow', 20);

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

async function cloneOverleafProject(
  context: vscode.ExtensionContext,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Clone Overleaf Project',
    prompt: 'Enter an Overleaf project URL or 24-character project ID.',
    placeHolder: 'https://git.overleaf.com/<project-id>',
    ignoreFocusOut: true,
  });

  if (!input) {
    return;
  }

  const match = input.trim().match(/[a-f0-9]{24}/i);
  if (!match) {
    vscode.window.showErrorMessage(
      'Enter a valid Overleaf project URL or 24-character project ID.',
    );
    return;
  }

  const projectId = match[0];
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    vscode.window.showErrorMessage(
      'Open a workspace folder before cloning an Overleaf project.',
    );
    return;
  }

  const tokenKey = 'overleaf.gitToken';
  const validateToken = (value: string): boolean => value.startsWith('olp_');

  let token = (await context.secrets.get(tokenKey))?.trim() ?? '';
  if (token && !validateToken(token)) {
    await context.secrets.delete(tokenKey);
    token = '';
  }

  if (!token) {
    const tokenInput = await vscode.window.showInputBox({
      title: 'Overleaf Git Token',
      prompt: 'Enter your Overleaf Git token (starts with "olp_").',
      ignoreFocusOut: true,
      password: true,
    });

    if (!tokenInput) {
      vscode.window.showWarningMessage('Overleaf clone cancelled.');
      return;
    }

    const trimmedToken = tokenInput.trim();
    if (!trimmedToken) {
      vscode.window.showWarningMessage('Overleaf clone cancelled.');
      return;
    }

    if (!validateToken(trimmedToken)) {
      vscode.window.showErrorMessage(
        'Enter a valid Overleaf Git token. Tokens start with "olp_".',
      );
      return;
    }

    token = trimmedToken;
    await context.secrets.store(tokenKey, token);
  }

  const encodedToken = encodeURIComponent(token);
  const remote = `https://git:${encodedToken}@git.overleaf.com/${projectId}`;

  const gitCheck = execaSync('git', ['--version'], { reject: false });
  if (gitCheck.exitCode !== 0) {
    vscode.window.showErrorMessage(
      'Git must be installed and available in PATH to clone an Overleaf project.',
    );
    return;
  }

  let directoryEntries: Dirent[];
  try {
    directoryEntries = await fs.readdir(workspacePath, { withFileTypes: true });
  } catch (error) {
    vscode.window.showErrorMessage(
      'Unable to inspect the workspace folder before cloning the Overleaf project.',
    );
    logger.error('Failed to read workspace contents:', error);
    return;
  }

  const ignoredWorkspaceEntries = new Set(['.DS_Store', 'Thumbs.db']);
  const nonIgnoredEntries = directoryEntries.filter(
    (entry) => !ignoredWorkspaceEntries.has(entry.name),
  );

  if (nonIgnoredEntries.length > 0) {
    vscode.window.showErrorMessage(
      'The workspace folder must be empty before cloning an Overleaf project.',
    );
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Cloning Overleaf project…',
      },
      async () => {
        await execa('git', ['clone', remote, '.'], {
          cwd: workspacePath,
          env: { GIT_TERMINAL_PROMPT: '0' },
        });
      },
    );
    vscode.window.showInformationMessage(
      'Overleaf project cloned into the workspace root.',
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      'Failed to clone Overleaf project. Check your connection, token, and workspace folder.',
    );

    if (error instanceof Error) {
      const sanitizedMessage = error.message
        .replaceAll(token, '********')
        .replaceAll(encodedToken, '********');
      logger.error('Overleaf clone failed:', sanitizedMessage);
    } else {
      logger.error('Overleaf clone failed with non-error value:', error);
    }
  }
}

export const gitCommands = {
  isGitRepository,
  getRecentCommits,
  findCommitInHistory,
  cloneOverleafProject,
};
