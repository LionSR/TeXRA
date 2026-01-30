import * as path from 'path';

import * as vscode from 'vscode';

import { agentDirectories } from '@frontend/agents';
import * as logger from '@logger/logUtils';
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

  private builtInPathsPromise: Promise<{
    builtInAgentsPath: string;
    builtInToolUsePath: string;
  }>;

  constructor() {
    this.builtInPathsPromise = this.loadBuiltInPaths();
  }

  private async loadBuiltInPaths(): Promise<{
    builtInAgentsPath: string;
    builtInToolUsePath: string;
  }> {
    const [builtInAgentsPath, builtInToolUsePath] = await Promise.all([
      agentDirectories.builtIn(),
      agentDirectories.builtInToolUse(),
    ]);
    return { builtInAgentsPath, builtInToolUsePath };
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    const isFile = element.collapsibleState === vscode.TreeItemCollapsibleState.None;
    if (element.editing) {
      element.contextValue = 'editing';
    } else if (element.isBuiltIn) {
      element.contextValue = isFile ? 'builtInFile' : 'builtInFolder';
    } else {
      element.contextValue = isFile ? 'file' : 'folder';
    }
    return element;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    try {
      if (element) {
        return this.getFilesInDirectory(element.resourceUri.fsPath);
      }

      const { builtInAgentsPath, builtInToolUsePath } =
        await this.builtInPathsPromise;
      const items: FileItem[] = [
        new FileItem(
          'Built-in Agents',
          vscode.Uri.file(builtInAgentsPath),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
        new FileItem(
          'Tool Use Agents',
          vscode.Uri.file(builtInToolUsePath),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      ];

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
      const { builtInAgentsPath, builtInToolUsePath } =
        await this.builtInPathsPromise;

      const items: FileItem[] = [];
      for (const [name, type] of dirEntries) {
        if (name.startsWith('.')) {
          continue;
        }

        const resourceUri = vscode.Uri.file(path.join(dirPath, name));
        const isBuiltIn =
          resourceUri.fsPath.startsWith(builtInAgentsPath) ||
          resourceUri.fsPath.startsWith(builtInToolUsePath);
        const isDirectory = type === vscode.FileType.Directory;

        items.push(
          new FileItem(
            name,
            resourceUri,
            isDirectory
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
            isDirectory
              ? undefined
              : {
                  command: 'texra.folderExplorer.openFile',
                  title: 'Open File',
                  arguments: [resourceUri],
                },
            isBuiltIn,
          ),
        );
      }

      return items.sort((a, b) => {
        const aIsFolder = a.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
        const bIsFolder = b.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
        if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
        return String(a.label ?? '').localeCompare(String(b.label ?? ''));
      });
    } catch (err) {
      logger.error(CHANNEL, `Error reading directory: ${err}`);
      return [];
    }
  }
}
