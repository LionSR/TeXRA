// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

/** Minimal types for the vscode.git extension public API (version 1). */
interface GitRepository {
  readonly rootUri: vscode.Uri;
}

interface GitAPI {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

function hasFileType(stat: vscode.FileStat, type: vscode.FileType): boolean {
  return (stat.type & type) !== 0;
}

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
    return path.dirname(commonGitDir);
  }

  return repoRoot;
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
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
      return undefined;
    }

    const exports = ext.isActive ? ext.exports : await ext.activate();
    const git = exports.getAPI(1);
    const repo = git.getRepository(vscode.Uri.file(workspacePath));
    if (!repo) {
      return undefined;
    }

    const gitEntryUri = vscode.Uri.joinPath(repo.rootUri, '.git');
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(gitEntryUri);
    } catch {
      return undefined;
    }

    if (hasFileType(stat, vscode.FileType.Directory)) {
      return repo.rootUri.fsPath;
    }

    if (!hasFileType(stat, vscode.FileType.File)) {
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
  } catch {
    return undefined;
  }
}
