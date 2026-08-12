// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import * as logger from '@logger/logUtils';
import { normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

import { getGitAPI } from './gitExtensionTypes';

export function resolveCommonRootFromGitdir(
  repoRoot: string,
  gitdir: string,
): string {
  const normalizedGitdir = path.normalize(gitdir);
  const worktreesDir = path.dirname(normalizedGitdir);
  const commonGitDir = path.dirname(worktreesDir);

  if (
    path.basename(worktreesDir) === 'worktrees' &&
    path.basename(commonGitDir) === '.git'
  ) {
    return normalizeFilePath(path.dirname(commonGitDir));
  }

  return normalizeFilePath(repoRoot);
}

/**
 * Resolve the git common-directory root for a workspace path.
 *
 * For a main worktree the common root is the repository root. For additional
 * worktrees, `.git` is a file pointing into `.git/worktrees/<name>`, so this
 * returns the main repository root. Submodule `.git/modules/...` layouts fall
 * back to the submodule root to avoid namespace collisions.
 */
export async function resolveGitCommonRoot(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    const git = await getGitAPI();
    const repo = git?.getRepository(vscode.Uri.file(workspacePath));
    if (!repo) {
      return undefined;
    }

    const gitEntryUri = vscode.Uri.joinPath(repo.rootUri, '.git');
    // A FileNotFound stat is the expected "not a git repo" signal; other
    // failures are classified in the function-level catch below.
    const stat = await vscode.workspace.fs.stat(gitEntryUri);

    if (isDirectory(stat.type)) {
      return repo.rootUri.fsPath;
    }

    if (!isFile(stat.type)) {
      return undefined;
    }

    const bytes = await vscode.workspace.fs.readFile(gitEntryUri);
    const content = Buffer.from(bytes).toString('utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) {
      return undefined;
    }

    const gitdirValue = match[1].trim();
    const gitdir = path.isAbsolute(gitdirValue)
      ? gitdirValue
      : path.resolve(repo.rootUri.fsPath, gitdirValue);

    return resolveCommonRootFromGitdir(repo.rootUri.fsPath, gitdir);
  } catch (error) {
    // A missing `.git` entry is the expected "not a git repo" signal and maps
    // to `undefined`. Any other failure (git-extension activation rejection,
    // an EACCES/EIO stat or read, an unreadable `.git` file) means the
    // workspace may genuinely be a git repo whose root we failed to resolve —
    // log it loudly rather than silently downgrading to "no git repo"
    // (CLAUDE.md: silent degradation is a defect). The fallback still returns
    // undefined so extension activation isn't aborted by a root-resolution
    // problem.
    if (
      error instanceof vscode.FileSystemError &&
      error.code === 'FileNotFound'
    ) {
      return undefined;
    }
    logger.warn(
      'extension',
      `Failed to resolve git common root for ${workspacePath}: ${toErrorMessage(error)}`,
    );
    return undefined;
  }
}
