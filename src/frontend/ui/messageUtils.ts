// Third-party imports
import * as vscode from 'vscode';

/**
 * Platform abstraction layer for user-facing messages.
 * These wrappers enable future platform independence for backend code
 * that needs to display messages without direct VS Code coupling.
 */
export const showInfoMessage = vscode.window.showInformationMessage;
export const showWarningMessage = vscode.window.showWarningMessage;
export const showErrorMessage = vscode.window.showErrorMessage;
