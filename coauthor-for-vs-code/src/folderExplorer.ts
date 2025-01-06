// folderExplorer.ts
import * as path from 'path';
import * as vscode from 'vscode';
import * as logger from './logger/logUtils';
import { getConfig } from './frontend-utils/commonUtils';
import { getAgentsDirectory } from './utils/pathUtils';

const CHANNEL = 'FolderExplorer';
logger.initialize(CHANNEL);

export class FolderExplorer implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    FileItem | undefined | null | void
  > = new vscode.EventEmitter<FileItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    FileItem | undefined | null | void
  > = this._onDidChangeTreeData.event;
  private fileSystemWatcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private workspaceRoot: string | undefined,
    private context?: vscode.ExtensionContext,
  ) {
    // Initialize file system watcher
    this.setupFileSystemWatcher();
  }

  public async setupFileSystemWatcher() {
    try {
      if (!this.context) {
        return;
      }

      const watchPath = await getAgentsDirectory(this.context);

      // Dispose of existing watcher if any
      this.fileSystemWatcher?.dispose();

      // Create new watcher for the directory
      this.fileSystemWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(watchPath, '**/*'),
      );

      // Watch for all file system events
      this.fileSystemWatcher.onDidCreate(() => this.refresh());
      this.fileSystemWatcher.onDidDelete(() => this.refresh());
      this.fileSystemWatcher.onDidChange(() => this.refresh());

      logger.info(CHANNEL, `File system watcher set up for: ${watchPath}`);
    } catch (err) {
      logger.error(CHANNEL, `Error setting up file system watcher: ${err}`);
    }
  }

  // Add dispose method to clean up resources
  dispose() {
    this.fileSystemWatcher?.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (element) {
      // If element is provided, get its children
      const dirPath = element.resourceUri.fsPath;
      return this.getFilesInDirectory(dirPath);
    } else {
      // For root level, use getAgentsDirectory
      if (!this.context) {
        logger.error(CHANNEL, 'Extension context not available');
        return Promise.resolve([]);
      }

      try {
        const absolutePath = await getAgentsDirectory(this.context);
        logger.debug(CHANNEL, `Reading from: ${absolutePath}`);
        return this.getFilesInDirectory(absolutePath);
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error getting agents directory: ${err instanceof Error ? err.message : String(err)}`,
        );
        return Promise.resolve([]);
      }
    }
  }

  private async getFilesInDirectory(dirPath: string): Promise<FileItem[]> {
    try {
      const dirEntries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(dirPath),
      );
      const items: FileItem[] = [];

      for (const [name, type] of dirEntries) {
        // Skip hidden files and directories (starting with .)
        if (name.startsWith('.')) {
          continue;
        }

        const resourceUri = vscode.Uri.file(path.join(dirPath, name));

        if (type === vscode.FileType.Directory) {
          items.push(
            new FileItem(
              name,
              resourceUri,
              vscode.TreeItemCollapsibleState.Collapsed,
            ),
          );
        } else {
          items.push(
            new FileItem(
              name,
              resourceUri,
              vscode.TreeItemCollapsibleState.None,
              {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [resourceUri],
              },
            ),
          );
        }
      }

      return items.sort((a, b) => {
        // Directories first, then files
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

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
  ) {
    super(label, collapsibleState);

    this.tooltip = this.resourceUri.fsPath;
    // Don't show the description (relative path) anymore
    this.description = undefined;

    // Set different icons for files and folders
    if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
      this.iconPath = new vscode.ThemeIcon('file');
    } else {
      this.iconPath = new vscode.ThemeIcon('folder');
    }
  }
}
