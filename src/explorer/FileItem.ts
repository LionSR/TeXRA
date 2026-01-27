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

    const isFile = collapsibleState === vscode.TreeItemCollapsibleState.None;
    if (isBuiltIn && isFile) {
      this.resourceUri = this.resourceUri.with({
        scheme: 'file',
        query: 'readonly',
      });
      this.iconPath = new vscode.ThemeIcon('lock');
    } else {
      this.iconPath = new vscode.ThemeIcon(isFile ? 'file' : 'folder');
    }
  }
}
