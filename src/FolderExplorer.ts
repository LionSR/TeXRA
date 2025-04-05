// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as logger from './logger/logUtils';

// Local imports
import {
  getBuiltInAgentsDirectory,
  getCustomAgentsDirectory,
} from './utils/pathUtils';
import { fileExistsAbsolute } from './utils/absoluteFileUtils';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

/*
TODO: 
- make it possible to right click 
- make it possible to create new files like in vs code
*/

export class FolderExplorer implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    FileItem | undefined | null | void
  > = new vscode.EventEmitter<FileItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    FileItem | undefined | null | void
  > = this._onDidChangeTreeData.event;
  private fileSystemWatchers: vscode.FileSystemWatcher[] = [];
  private editingItem: FileItem | undefined;
  private builtInAgentsPath: string = '';

  constructor(
    private workspaceRoot: string | undefined,
    private context?: vscode.ExtensionContext,
  ) {
    // Initialize file system watcher
    this.setupFileSystemWatcher();
    this.registerCommands();

    // Initialize built-in agents path
    if (this.context) {
      getBuiltInAgentsDirectory(this.context).then((path) => {
        this.builtInAgentsPath = path;
      });
    }
  }

  private registerCommands() {
    if (!this.context) {
      return;
    }

    // Register commands for new file/folder creation
    this.context.subscriptions.push(
      vscode.commands.registerCommand(
        'texra.folderExplorer.newFile',
        (node: FileItem) => this.createNew(node, false),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.newFolder',
        (node: FileItem) => this.createNew(node, true),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.rename',
        (node: FileItem) => this.startRename(node),
      ),
      vscode.commands.registerCommand(
        'texra.folderExplorer.delete',
        (node: FileItem) => this.deleteItem(node),
      ),
      // Register custom file open command
      vscode.commands.registerCommand(
        'texra.folderExplorer.openFile',
        (uri: vscode.Uri) => this.openFile(uri),
      ),
    );
  }

  // Custom file open handler
  private async openFile(uri: vscode.Uri) {
    try {
      // Check if file is in built-in agents directory
      const isBuiltIn =
        this.builtInAgentsPath && uri.fsPath.startsWith(this.builtInAgentsPath);

      // Open the document
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);

      // If it's a built-in agent file, make it read-only and show notification
      if (isBuiltIn) {
        // Set editor to read-only using the correct command
        await vscode.commands.executeCommand(
          'workbench.action.files.setActiveEditorReadonlyInSession',
        );

        // Show notification
        const message =
          'This is a built-in agent prompt file and should not be modified directly.';
        const createCustom = 'Create Custom Copy';

        vscode.window
          .showWarningMessage(message, createCustom)
          .then((selection) => {
            if (selection === createCustom) {
              this.createCustomCopy(uri);
            }
          });
      }
    } catch (err) {
      logger.error(CHANNEL, `Error opening file: ${err}`);
      vscode.window.showErrorMessage(`Failed to open file: ${err}`);
    }
  }

  // Create a custom copy of a built-in agent file
  private async createCustomCopy(uri: vscode.Uri) {
    try {
      const customPath = await getCustomAgentsDirectory();
      if (!customPath) {
        vscode.window.showErrorMessage(
          'Custom agents directory not configured. Please set it in settings.',
        );
        return;
      }

      // Get relative path from built-in directory
      const relativePath = path.relative(this.builtInAgentsPath, uri.fsPath);
      const targetPath = path.join(customPath, relativePath);

      // Ensure target directory exists
      const targetDir = path.dirname(targetPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));

      // Copy the file
      const content = await vscode.workspace.fs.readFile(uri);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), content);

      // Open the new file
      const newDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(targetPath),
      );
      await vscode.window.showTextDocument(newDoc);

      vscode.window.showInformationMessage(
        `Created custom copy at: ${targetPath}`,
      );
    } catch (err) {
      logger.error(CHANNEL, `Error creating custom copy: ${err}`);
      vscode.window.showErrorMessage(`Failed to create custom copy: ${err}`);
    }
  }

  private async createNew(node: FileItem | undefined, isFolder: boolean) {
    try {
      const parentPath =
        node?.resourceUri.fsPath ||
        (this.context
          ? await getBuiltInAgentsDirectory(this.context)
          : undefined);

      if (!parentPath) {
        throw new Error('No valid parent path found');
      }

      // Create a temporary item for in-place editing
      const tempName = isFolder ? 'New Folder' : 'new-file.yaml';
      const resourceUri = vscode.Uri.file(path.join(parentPath, tempName));

      const newItem = new FileItem(
        tempName,
        resourceUri,
        isFolder
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );

      // Set the item in editing mode
      newItem.editing = true;
      this.editingItem = newItem;

      // Refresh the tree to show the new item in editing mode
      this.refresh();

      // Start the rename process immediately
      this.startRename(newItem);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error creating new ${isFolder ? 'folder' : 'file'}: ${err}`,
      );
      vscode.window.showErrorMessage(
        `Failed to create new ${isFolder ? 'folder' : 'file'}`,
      );
    }
  }

  private async startRename(item: FileItem) {
    if (!item) {
      return;
    }

    // Prevent renaming built-in files/folders
    if (item.isBuiltIn) {
      vscode.window.showWarningMessage(
        'Built-in agent files cannot be renamed. Create a custom copy instead.',
      );
      return;
    }

    this.editingItem = item;
    item.editing = true;
    this.refresh();

    // Show the rename input box
    const newName = await vscode.window.showInputBox({
      value: item.label,
      prompt: `Enter new name for ${item.label}`,
      validateInput: (value) => {
        if (!value) {
          return 'Name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Name cannot contain path separators';
        }
        return null;
      },
    });

    // Handle the rename result
    if (newName && newName !== item.label) {
      try {
        const oldPath = item.resourceUri.fsPath;
        const newPath = path.join(path.dirname(oldPath), newName);

        // For new items, create them
        if (!(await fileExistsAbsolute(oldPath))) {
          if (item.collapsibleState === vscode.TreeItemCollapsibleState.None) {
            // Create new file
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(newPath),
              new Uint8Array(),
            );
          } else {
            // Create new folder
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(newPath));
          }
        } else {
          // Rename existing item
          await vscode.workspace.fs.rename(
            vscode.Uri.file(oldPath),
            vscode.Uri.file(newPath),
            { overwrite: false },
          );
        }
      } catch (err) {
        logger.error(CHANNEL, `Error renaming item: ${err}`);
        vscode.window.showErrorMessage('Failed to rename item');
      }
    }

    // Clear editing state
    this.editingItem = undefined;
    item.editing = false;
    this.refresh();
  }

  public async setupFileSystemWatcher() {
    try {
      if (!this.context) {
        return;
      }

      // Watch both built-in and custom directories
      const builtInPath = await getBuiltInAgentsDirectory(this.context);
      const customPath = await getCustomAgentsDirectory();

      // Dispose of existing watchers
      this.dispose();

      // Create watchers for both directories
      this.fileSystemWatchers = [
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(builtInPath, '**/*'),
        ),
      ];

      if (customPath) {
        this.fileSystemWatchers.push(
          vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(customPath, '**/*'),
          ),
        );
      }

      // Watch for all file system events
      this.fileSystemWatchers.forEach((watcher) => {
        watcher.onDidCreate(() => this.refresh());
        watcher.onDidDelete(() => this.refresh());
        watcher.onDidChange(() => this.refresh());
      });

      logger.info(
        CHANNEL,
        `File system watchers set up for: ${[builtInPath, customPath].filter(Boolean).join(', ')}`,
      );
    } catch (err) {
      logger.error(CHANNEL, `Error setting up file system watcher: ${err}`);
    }
  }

  // Add dispose method to clean up resources
  dispose() {
    this.fileSystemWatchers.forEach((watcher) => watcher.dispose());
    this.fileSystemWatchers = [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    if (element.editing) {
      element.contextValue = 'editing';
    } else if (element.isBuiltIn) {
      // Set special context value for built-in items to control context menu
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
    if (!this.context) {
      logger.error(CHANNEL, 'Extension context not available');
      return Promise.resolve([]);
    }

    try {
      if (element) {
        // If element is provided, get its children
        return this.getFilesInDirectory(element.resourceUri.fsPath);
      } else {
        // For root level, create Built-in and Custom root items
        const items: FileItem[] = [];

        // Add Built-in Agents folder
        const builtInPath = await getBuiltInAgentsDirectory(this.context);
        const builtInItem = new FileItem(
          'Built-in Agents',
          vscode.Uri.file(builtInPath),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        items.push(builtInItem);

        // Add Custom Agents folder if configured
        const customPath = await getCustomAgentsDirectory();
        if (customPath) {
          const customItem = new FileItem(
            'Custom Agents',
            vscode.Uri.file(customPath),
            vscode.TreeItemCollapsibleState.Collapsed,
          );
          items.push(customItem);
        }

        return items;
      }
    } catch (err) {
      logger.error(CHANNEL, `Error getting children: ${err}`);
      return [];
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

        // Check if file is in built-in agents directory
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
                command: 'texra.folderExplorer.openFile', // Use custom command instead of vscode.open
                title: 'Open File',
                arguments: [resourceUri],
              },
              !!isBuiltIn,
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

  private async deleteItem(item: FileItem) {
    if (!item) {
      return;
    }

    // Prevent deleting built-in files/folders
    if (item.isBuiltIn) {
      vscode.window.showWarningMessage(
        'Built-in agent files cannot be deleted. Create a custom copy if you need to modify them.',
      );
      return;
    }

    const isFolder =
      item.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
    const confirmMessage = `Are you sure you want to delete ${isFolder ? 'folder' : 'file'} "${item.label}"?`;
    const confirmButton = 'Delete';

    const choice = await vscode.window.showWarningMessage(
      confirmMessage,
      { modal: true },
      confirmButton,
    );

    if (choice === confirmButton) {
      try {
        if (isFolder) {
          await vscode.workspace.fs.delete(item.resourceUri, {
            recursive: true,
          });
        } else {
          await vscode.workspace.fs.delete(item.resourceUri);
        }
        logger.info(
          CHANNEL,
          `Successfully deleted ${isFolder ? 'folder' : 'file'}: ${item.resourceUri.fsPath}`,
        );
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error deleting ${isFolder ? 'folder' : 'file'}: ${err}`,
        );
        vscode.window.showErrorMessage(
          `Failed to delete ${isFolder ? 'folder' : 'file'}`,
        );
      }
    }
  }
}

class FileItem extends vscode.TreeItem {
  public editing: boolean = false;

  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly isBuiltIn: boolean = false,
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

    // Add lock icon for built-in files
    if (
      isBuiltIn &&
      collapsibleState === vscode.TreeItemCollapsibleState.None
    ) {
      // Set readonly status in the tree view
      this.resourceUri = this.resourceUri.with({
        scheme: 'file',
        query: 'readonly',
      });
      // Add lock icon
      this.iconPath = new vscode.ThemeIcon('lock');
    }
  }
}
