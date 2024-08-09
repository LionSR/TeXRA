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
    return section ? vscode.workspace.getConfiguration(section) : vscode.workspace.getConfiguration('coauthor');
}

export function ensureArray<T>(value: T | T[] | null | undefined): T[] {
    if (Array.isArray(value)) {
        return value;
    } else if (value !== null && value !== undefined) {
        return [value];
    }
    return [];
}