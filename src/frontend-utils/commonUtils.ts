// Third-party imports
import * as vscode from 'vscode';

export const showInfoMessage = vscode.window.showInformationMessage;
export const showWarningMessage = vscode.window.showWarningMessage;
export const showErrorMessage = vscode.window.showErrorMessage;

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
