// Third-party imports
import * as vscode from 'vscode';

export class FileItem extends vscode.TreeItem {
  public editing = false;

  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly isBuiltIn = false,
  ) {
    super(label, collapsibleState);

    this.tooltip = this.resourceUri.fsPath;
    this.description = undefined;

    if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
      this.iconPath = new vscode.ThemeIcon('file');
    } else {
      this.iconPath = new vscode.ThemeIcon('folder');
    }

    if (
      isBuiltIn &&
      collapsibleState === vscode.TreeItemCollapsibleState.None
    ) {
      this.resourceUri = this.resourceUri.with({
        scheme: 'file',
        query: 'readonly',
      });
      this.iconPath = new vscode.ThemeIcon('lock');
    }
  }
}
