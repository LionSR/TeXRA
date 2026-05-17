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

function computeDefaultUri(options: FileDialogOptions): vscode.Uri | null {
  if (options.defaultUri !== undefined) {
    return options.defaultUri;
  }
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return null;
  }
  const basePath = options.currentFile
    ? path.dirname(path.join(workspacePath, options.currentFile))
    : workspacePath;
  return vscode.Uri.file(basePath);
}

/**
 * Generic helper to show an open file dialog and return selected relative paths.
 */
export async function selectFiles(
  options: FileDialogOptions,
): Promise<string[] | null> {
  const defaultUri = computeDefaultUri(options);
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

  if (!fileUris?.length) {
    return null;
  }
  return fileUris.map((uri) => WorkspaceFS.relativePath(uri.fsPath));
}

/**
 * Convenience wrapper for single file selection.
 */
export async function selectFile(
  options: FileDialogOptions,
): Promise<string | null> {
  const paths = await selectFiles({ ...options, allowMany: false });
  return paths?.[0] ?? null;
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
  const relativePath = await selectFile(options);
  if (!relativePath) return null;

  return {
    relativePath,
    absolutePath: WorkspaceFS.fullPath(relativePath),
  };
}
