// Third-party imports
import * as vscode from 'vscode';

export const showInfoMessage = vscode.window.showInformationMessage;
export const showErrorMessage = vscode.window.showErrorMessage;

export function getConfig<T>(path: string, defaultValue?: T): T {
  const parts = path.split('.');

  // First try getting the config as is (e.g., for latex.latexindentConfig)
  let result: any = vscode.workspace
    .getConfiguration(parts[0])
    .get(parts.slice(1).join('.'));

  // If not found, try under coauthor namespace
  if (result === undefined) {
    result = vscode.workspace.getConfiguration('coauthor').get(path);
  }

  // If still not found, try with explicit coauthor prefix
  if (result === undefined) {
    result = vscode.workspace.getConfiguration().get(`coauthor.${path}`);
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

export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function uncapitalize(str: string) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
