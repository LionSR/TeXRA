// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

export interface FileDialogOptions {
  /** Whether multiple files can be selected */
  allowMany?: boolean;
  /** Label for the open button */
  openLabel: string;
  /** Mapping from filter name to array of extensions without dots */
  filters: { [name: string]: string[] };
  /** Current file path relative to workspace (used to compute defaultUri) */
  currentFile?: string;
  /** Optional defaultUri to use directly */
  defaultUri?: vscode.Uri | null;
}

function getDefaultUri(currentFile: string): vscode.Uri | null {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) {
    return null;
  }
  return currentFile
    ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentFile)))
    : vscode.Uri.file(workspacePath);
}

/**
 * Generic helper to show an open file dialog and return selected relative paths.
 */
export async function selectFiles(
  options: FileDialogOptions,
): Promise<string[] | null> {
  const defaultUri =
    options.defaultUri ??
    (options.currentFile
      ? getDefaultUri(options.currentFile)
      : getDefaultUri(''));
  if (!defaultUri) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }

  const fileUris = await vscode.window.showOpenDialog({
    canSelectMany: options.allowMany ?? false,
    openLabel: options.openLabel,
    canSelectFiles: true,
    canSelectFolders: false,
    defaultUri,
    filters: options.filters,
  });

  return fileUris && fileUris.length > 0
    ? fileUris.map((uri) => vscode.workspace.asRelativePath(uri.fsPath, false))
    : null;
}

/**
 * Convenience wrapper for single file selection.
 */
export async function selectFile(
  options: FileDialogOptions,
): Promise<string | null> {
  const paths = await selectFiles({ ...options, allowMany: false });
  return paths ? paths[0] : null;
}

export interface FileSelectionResult {
  relativePath: string;
  absolutePath: string;
}

/**
 * Prompts the user to select a file within the current workspace.
 * Returns both the workspace-relative and absolute paths for downstream
 * consumers. Returns null when the workspace is unavailable or the user
 * cancels the dialog.
 */
export async function selectFileFromWorkspace(
  options: FileDialogOptions,
): Promise<FileSelectionResult | null> {
  if (!WorkspaceFS.getPath()) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }

  const relativePath = await selectFile(options);

  if (!relativePath) {
    return null;
  }

  const absolutePath = WorkspaceFS.fullPath(relativePath);
  return { relativePath, absolutePath };
}
