// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from './logger/logUtils';
import { initializeSecrets } from './utils/secretUtils';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { registerCommands } from './commands';

async function copyDefaultAgents(context: vscode.ExtensionContext) {
  // Get current extension version from package.json
  const currentVersion = vscode.extensions.getExtension(context.extension.id)
    ?.packageJSON.version;
  const lastKnownVersion = context.globalState.get('lastKnownVersion');

  // Only proceed if version has changed
  if (currentVersion === lastKnownVersion) {
    console.log('Extension version unchanged, skipping agent copy');
    return;
  }

  console.log(
    `Extension version changed from ${lastKnownVersion} to ${currentVersion}, updating agents`,
  );

  const resourcesPath = path.join(context.extensionPath, 'resources', 'agents');
  const globalStoragePath = path.join(
    context.globalStorageUri.fsPath,
    'agents',
  );

  console.log('Resources path:', resourcesPath);
  console.log('Global storage path:', globalStoragePath);

  try {
    // Ensure the global storage agents directory exists
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(globalStoragePath),
    );
    console.log('Created or verified global storage directory');

    // Recursive function to copy files and directories
    const copyRecursively = async (sourcePath: string, targetPath: string) => {
      const stats = await fs.promises.stat(sourcePath);

      if (stats.isDirectory()) {
        console.log(`Processing directory: ${sourcePath}`);

        // Create target directory
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetPath));

        // Read and copy contents
        const files = await fs.promises.readdir(sourcePath);
        for (const file of files) {
          const sourceFilePath = path.join(sourcePath, file);
          const targetFilePath = path.join(targetPath, file);
          await copyRecursively(sourceFilePath, targetFilePath);
        }
      } else {
        // Copy file with overwrite
        console.log(`Copying file: ${sourcePath} to ${targetPath}`);
        const content = await fs.promises.readFile(sourcePath);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(targetPath),
          content,
        );
        console.log(`Successfully copied: ${sourcePath}`);
      }
    };

    // Start recursive copy from root
    await copyRecursively(resourcesPath, globalStoragePath);

    // Update the stored version after successful copy
    await context.globalState.update('lastKnownVersion', currentVersion);
    console.log('Updated stored extension version');
  } catch (err) {
    console.error('Error copying default agents:', err);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Initialize secrets storage
  initializeSecrets(context);

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);
  logger.setProgressViewProvider(progressViewProvider);

  // Copy default agents
  copyDefaultAgents(context);

  // Register commands first - this will create and store the TeXRAViewProvider
  const registeredCommands = registerCommands(context);

  // Register the folder explorer with context
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const folderExplorer = new FolderExplorer(workspaceRoot, context);

  // Register the tree data provider and webview providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.progressView',
      progressViewProvider,
    ),
    // Removed duplicate mainViewProvider registration since it's handled in commands.ts
    vscode.window.registerTreeDataProvider(
      'texra.folderExplorer',
      folderExplorer,
    ),
    // Add watcher for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('texra.explorer.agentsDirectory')) {
        folderExplorer.setupFileSystemWatcher();
        folderExplorer.refresh();
      }
    }),
    // Add disposable for cleanup
    { dispose: () => folderExplorer.dispose() },
  );
}

export function deactivate() {
  // Get the ProgressViewProvider instance
  const progressViewProvider = ProgressViewProvider.getInstance();
  if (progressViewProvider) {
    // Mark all running tasks as cancelled when extension deactivates
    progressViewProvider.markAllRunningTasksAsCancelled();
  }
}
