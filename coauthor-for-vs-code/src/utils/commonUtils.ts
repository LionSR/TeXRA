import * as vscode from 'vscode';
import * as path from 'path';

export function getWorkspacePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    return workspaceFolders ? workspaceFolders[0].uri.fsPath : undefined;
}

export function getRelativePath(filePath: string): string {
    const workspacePath = getWorkspacePath();
    return workspacePath ? path.relative(workspacePath, filePath) : filePath;
}

export function showInfoMessage(message: string): void {
    vscode.window.showInformationMessage(message);
}

export function showErrorMessage(message: string): void {
    vscode.window.showErrorMessage(message);
}

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('coauthor');
}
