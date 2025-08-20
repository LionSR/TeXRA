// Third-party imports
import * as vscode from 'vscode';

// Local imports - explorer
import { ExplorerOperations } from './ExplorerOperations';
import { FileItem } from './FileItem';

export class ExplorerCommands {
  constructor(
    private context: vscode.ExtensionContext,
    private operations: ExplorerOperations,
  ) {}

  register() {
    this.context.subscriptions.push(
      vscode.commands.registerCommand(
        'texra.folderExplorer.newFile',
        (node: FileItem) => this.operations.create(node, false),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.newFolder',
        (node: FileItem) => this.operations.create(node, true),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.rename',
        (node: FileItem) => this.operations.rename(node),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.delete',
        (node: FileItem) => this.operations.delete(node),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.openFile',
        (uri: vscode.Uri) => this.operations.open(uri),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.addToList',
        (node: FileItem) => this.operations.addToList(node),
      ),
    );
  }
}
