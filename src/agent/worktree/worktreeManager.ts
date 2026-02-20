/**
 * Git worktree lifecycle management for isolated agent sessions.
 *
 * Creates worktrees from the main workspace so agents can work
 * on separate branches without affecting the user's working tree.
 * Worktrees are stored under VS Code's workspace storage (already
 * per-workspace, cross-platform, and cleaned up on uninstall).
 */

// Standard library imports
import * as fs from 'fs/promises';
import * as path from 'path';

// Third-party imports
import { execa } from 'execa';

// VS Code API
import * as vscode from 'vscode';

// Local imports
import { StorageFS } from '@utils/files';
import { clearGitignoreCache } from '@tools/gitignore';

/** Information about a created git worktree. */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * Create a git worktree for an isolated agent session.
 *
 * @throws If the workspace is not a git repository or worktree creation fails.
 */
export async function createWorktree(options: {
  executionId: string;
  agentName: string;
  baseBranch?: string;
}): Promise<WorktreeInfo> {
  // Always use the real VS Code workspace root, not the context-aware override.
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) {
    throw new Error('No workspace path available for worktree creation.');
  }

  const shortId = options.executionId.slice(0, 8);
  const branch = `agent/${options.agentName}-${shortId}`;
  const worktreePath = path.join(
    StorageFS.getBasePath(),
    'worktrees',
    options.executionId,
  );

  // Create only the parent directory — git worktree add needs to create the target itself.
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const args = ['worktree', 'add', worktreePath, '-b', branch];
  if (options.baseBranch) {
    args.push(options.baseBranch);
  }

  try {
    await execa('git', args, { cwd: workspacePath, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return { path: worktreePath, branch };
}

/**
 * Remove a git worktree after agent completion.
 * Best-effort: swallows errors (worktree may already be removed).
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  try {
    await execa('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    // Worktree may already be removed or path invalid
  }

  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});

  // Evict cached gitignore matcher for this worktree root to prevent memory leak.
  clearGitignoreCache(worktreePath);
}
