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
    // Separate by argument type for type safety
    const fileItemCommands: Array<[string, (node: FileItem) => unknown]> = [
      ['newFile', (node) => this.operations.create(node, false)],
      ['newFolder', (node) => this.operations.create(node, true)],
      ['rename', (node) => this.operations.rename(node)],
      ['delete', (node) => this.operations.delete(node)],
      ['addToList', (node) => this.operations.addToList(node)],
      ['revealInOS', (node) => this.operations.reveal(node.resourceUri)],
    ];

    this.context.subscriptions.push(
      ...fileItemCommands.map(([name, handler]) =>
        vscode.commands.registerCommand(
          `texra.folderExplorer.${name}`,
          handler,
        ),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.openFile',
        (uri: vscode.Uri) => this.operations.open(uri),
      ),
    );
  }
}
