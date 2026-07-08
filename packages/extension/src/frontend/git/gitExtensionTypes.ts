/**
 * Minimal shared types for the built-in `vscode.git` extension's public API
 * (version 1), plus the activation dance to obtain it. Single source of
 * truth — extend these interfaces rather than redeclaring them per feature.
 */

// Third-party imports
import * as vscode from 'vscode';

interface GitBranchInfo {
  readonly name?: string;
  readonly commit?: string;
}

interface GitRepositoryState {
  readonly HEAD: GitBranchInfo | undefined;
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

export interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

/**
 * Resolve the built-in git extension's API, activating the extension if
 * needed. Returns undefined when the git extension is not installed.
 */
export async function getGitAPI(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive
    ? extension.exports
    : await extension.activate();
  return exports.getAPI(1);
}
