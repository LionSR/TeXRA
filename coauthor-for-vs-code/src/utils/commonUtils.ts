import * as vscode from 'vscode';
import * as path from 'path';

export function getWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
}

export function getRelativePath(filePath: string): string {
  const workspacePath = getWorkspacePath();
  return workspacePath ? path.relative(workspacePath, filePath) : filePath;
}

export const showInfoMessage = vscode.window.showInformationMessage;
export const showErrorMessage = vscode.window.showErrorMessage;

export function getConfig(section?: string): vscode.WorkspaceConfiguration {
  return section
    ? vscode.workspace.getConfiguration(section)
    : vscode.workspace.getConfiguration('coauthor');
}

export function getNestedConfig<T>(path: string, defaultValue?: T): T {
  const config = getConfig();
  const parts = path.split('.');

  // For nested configs in package.json, we need to check both with and without 'coauthor.' prefix
  let result: any = config.get(parts.join('.'));

  // If not found, try with explicit section paths
  if (result === undefined) {
    // Try getting from the full path including 'coauthor'
    result = vscode.workspace
      .getConfiguration()
      .get(`coauthor.${parts.join('.')}`);
  }

  // Return default value if still undefined
  return result !== undefined ? result : (defaultValue as T);
}

export function ensureArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  } else if (value !== null && value !== undefined) {
    return [value];
  }
  return [];
}
