// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

// Local imports
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { AbsoluteFS } from '@utils/files';
import { FileItem } from './explorer/FileItem';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class FolderExplorer implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    FileItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private builtInAgentsPath = '';

  constructor(
    private workspaceRoot: string | undefined,
    _context?: vscode.ExtensionContext,
  ) {
    agentDirectories.builtIn().then((p) => {
      this.builtInAgentsPath = p;
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    if (element.editing) {
      element.contextValue = 'editing';
    } else if (element.isBuiltIn) {
      element.contextValue =
        element.collapsibleState === vscode.TreeItemCollapsibleState.None
          ? 'builtInFile'
          : 'builtInFolder';
    } else {
      element.contextValue =
        element.collapsibleState === vscode.TreeItemCollapsibleState.None
          ? 'file'
          : 'folder';
    }
    return element;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    try {
      if (element) {
        return this.getFilesInDirectory(element.resourceUri.fsPath);
      }

      const items: FileItem[] = [];
      const builtInPath = await agentDirectories.builtIn();
      const builtInToolUsePath = await agentDirectories.builtInToolUse();
      items.push(
        new FileItem(
          'Built-in Agents',
          vscode.Uri.file(builtInPath),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      );
      items.push(
        new FileItem(
          'Tool Use Agents',
          vscode.Uri.file(builtInToolUsePath),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      );

      const customPath = await agentDirectories.custom();
      if (customPath) {
        items.push(
          new FileItem(
            'Custom Agents',
            vscode.Uri.file(customPath),
            vscode.TreeItemCollapsibleState.Collapsed,
          ),
        );
      }

      return items;
    } catch (err) {
      logger.error(CHANNEL, `Error getting children: ${err}`);
      return [];
    }
  }

  private async getFilesInDirectory(dirPath: string): Promise<FileItem[]> {
    try {
      const dirEntries = await AbsoluteFS.readDir(dirPath);
      const items: FileItem[] = [];

      for (const [name, type] of dirEntries) {
        if (name.startsWith('.')) {
          continue;
        }

        const resourceUri = vscode.Uri.file(path.join(dirPath, name));
        const isBuiltIn =
          this.builtInAgentsPath &&
          resourceUri.fsPath.startsWith(this.builtInAgentsPath);

        if (type === vscode.FileType.Directory) {
          items.push(
            new FileItem(
              name,
              resourceUri,
              vscode.TreeItemCollapsibleState.Collapsed,
              undefined,
              !!isBuiltIn,
            ),
          );
        } else {
          items.push(
            new FileItem(
              name,
              resourceUri,
              vscode.TreeItemCollapsibleState.None,
              {
                command: 'texra.folderExplorer.openFile',
                title: 'Open File',
                arguments: [resourceUri],
              },
              !!isBuiltIn,
            ),
          );
        }
      }

      return items.sort((a, b) => {
        if (a.collapsibleState !== b.collapsibleState) {
          return b.collapsibleState ===
            vscode.TreeItemCollapsibleState.Collapsed
            ? 1
            : -1;
        }
        return a.label!.toString().localeCompare(b.label!.toString());
      });
    } catch (err) {
      logger.error(CHANNEL, `Error reading directory: ${err}`);
      return [];
    }
  }
}
