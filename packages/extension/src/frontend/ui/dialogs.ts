// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'dialogs';

export interface FileDialogOptions {
  /** Whether multiple files can be selected */
  allowMany?: boolean;
  /** Label for the open button */
  openLabel: string;
  /** Mapping from filter name to array of extensions without dots */
  filters: { [name: string]: string[] };
  /** Current file path relative to workspace (used to compute defaultUri) */
  currentFile?: string;
}

function computeDefaultUri(options: FileDialogOptions): vscode.Uri | null {
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
 * Show a modal warning dialog with `actionLabel` as the primary button
 * (plus any `otherLabels`, in order) and resolve `true` iff the user picked
 * `actionLabel`. Dismissing the dialog (Escape/X) resolves `false`, same as
 * picking any other button.
 */
export async function confirmModal(
  message: string,
  actionLabel: string,
  ...otherLabels: string[]
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    actionLabel,
    ...otherLabels,
  );
  return choice === actionLabel;
}

/**
 * Generic helper to show an open file dialog and return selected relative paths.
 */
export async function selectFiles(
  options: FileDialogOptions,
): Promise<string[] | null> {
  const defaultUri = computeDefaultUri(options);
  if (!defaultUri) {
    void showLoggedMessage(CHANNEL, 'No workspace folder open');
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

export interface FolderDialogOptions {
  /** Label for the open button */
  openLabel: string;
  /** Optional dialog title */
  title?: string;
}

/**
 * Generic helper to show a folder-picker dialog and return the selected
 * absolute path. Unlike {@link selectFiles}, this never
 * touches `WorkspaceFS`, so it's safe to call before a workspace (or
 * `platform()`) is available.
 */
export async function selectFolder(
  options: FolderDialogOptions,
): Promise<string | null> {
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: options.openLabel,
    ...(options.title ? { title: options.title } : {}),
  });
  return folders?.[0]?.fsPath ?? null;
}
