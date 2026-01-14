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
    const commands: Array<[string, (arg: FileItem | vscode.Uri) => unknown]> = [
      ['newFile', (node) => this.operations.create(node as FileItem, false)],
      ['newFolder', (node) => this.operations.create(node as FileItem, true)],
      ['rename', (node) => this.operations.rename(node as FileItem)],
      ['delete', (node) => this.operations.delete(node as FileItem)],
      ['openFile', (uri) => this.operations.open(uri as vscode.Uri)],
      ['addToList', (node) => this.operations.addToList(node as FileItem)],
      ['revealInOS', (node) => this.operations.reveal((node as FileItem).resourceUri)],
    ];

    this.context.subscriptions.push(
      ...commands.map(([name, handler]) =>
        vscode.commands.registerCommand(`texra.folderExplorer.${name}`, handler),
      ),
    );
  }
}
