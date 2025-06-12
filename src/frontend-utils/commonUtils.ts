// Third-party imports
import * as vscode from 'vscode';
import { capitalize, uncapitalize } from '../utils/stringUtils';

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

export { capitalize, uncapitalize };
