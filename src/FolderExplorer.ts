// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Internal imports
import { agentDirectories } from '@frontend/agents';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

// Local file imports
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
  private builtInToolUsePath = '';

  constructor(
    _workspaceRoot: string | undefined,
    _context?: vscode.ExtensionContext,
  ) {
    void this.loadBuiltInPaths();
  }

  private async loadBuiltInPaths(): Promise<void> {
    const [builtInAgentsPath, builtInToolUsePath] = await Promise.all([
      agentDirectories.builtIn(),
      agentDirectories.builtInToolUse(),
    ]);
    this.builtInAgentsPath = builtInAgentsPath;
    this.builtInToolUsePath = builtInToolUsePath;
  }

  private async ensureBuiltInPaths(): Promise<{
    builtInAgentsPath: string;
    builtInToolUsePath: string;
  }> {
    if (this.builtInAgentsPath && this.builtInToolUsePath) {
      return {
        builtInAgentsPath: this.builtInAgentsPath,
        builtInToolUsePath: this.builtInToolUsePath,
      };
    }

    await this.loadBuiltInPaths();
    return {
      builtInAgentsPath: this.builtInAgentsPath,
      builtInToolUsePath: this.builtInToolUsePath,
    };
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
      const { builtInAgentsPath, builtInToolUsePath } =
        await this.ensureBuiltInPaths();
      items.push(
        new FileItem(
          'Built-in Agents',
          vscode.Uri.file(builtInAgentsPath),
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
          (this.builtInAgentsPath &&
            resourceUri.fsPath.startsWith(this.builtInAgentsPath)) ||
          (this.builtInToolUsePath &&
            resourceUri.fsPath.startsWith(this.builtInToolUsePath));

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
