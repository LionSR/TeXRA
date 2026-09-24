// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
export const resolveGitCommonRoot = Effect.fn('resolveGitCommonRoot')(
  function* (workspacePath: string) {
    return yield* Effect.tryPromise(() =>
      readGitCommonRoot(workspacePath),
    ).pipe(
      Effect.catch(({ cause: error }) => {
        // A missing `.git` entry is the expected "not a git repo" signal and
        // maps to `undefined`. Any other failure (git-extension activation
        // rejection, an EACCES/EIO stat or read, an unreadable `.git` file)
        // means the workspace may genuinely be a git repo whose root we
        // failed to resolve — log it loudly rather than silently downgrading
        // to "no git repo" (CLAUDE.md: silent degradation is a defect). The
        // fallback still answers undefined so extension activation isn't
        // aborted by a root-resolution problem.
        if (
          error instanceof vscode.FileSystemError &&
          error.code === 'FileNotFound'
        ) {
          return Effect.succeed(undefined);
        }
        return Effect.logWarning(
          `Failed to resolve git common root for ${workspacePath}: ${toErrorMessage(error)}`,
        ).pipe(withLogChannel('extension'), Effect.as(undefined));
      }),
    );
  },
);

async function readGitCommonRoot(
  workspacePath: string,
): Promise<string | undefined> {
  const git = await getGitAPI();
  const repo = git?.getRepository(vscode.Uri.file(workspacePath));
  if (!repo) {
    return undefined;
  }

  const gitEntryUri = vscode.Uri.joinPath(repo.rootUri, '.git');
  // A FileNotFound stat is the expected "not a git repo" signal; other
  // failures are classified by the caller.
  const stat = await vscode.workspace.fs.stat(gitEntryUri);

  // Bitwise against `vscode.FileType`, not equality: a symlinked `.git`
  // reports `SymbolicLink | Directory` or `SymbolicLink | File`, and a
  // worktree's `.git` file is as much a git entry as a directory is.
  if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
    return normalizeFilePath(repo.rootUri.fsPath);
  }

  if ((stat.type & vscode.FileType.File) !== vscode.FileType.File) {
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
}
