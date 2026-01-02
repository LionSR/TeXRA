// Third-party imports
import * as vscode from 'vscode';

/**
 * Message display utilities.
 * Abstracts VS Code message APIs for potential future platform independence.
 */
export const showInfoMessage = vscode.window.showInformationMessage;
export const showWarningMessage = vscode.window.showWarningMessage;
export const showErrorMessage = vscode.window.showErrorMessage;
