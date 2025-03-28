// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from './logger/logUtils';
import { initializeSecrets } from './utils/secretUtils';
import { fileExistsAbsolute } from './utils/absoluteFileUtils';
import { loadReplacementDefinitions } from './utils/replacementLoader';
import { setReplacementCache } from './utils/replacementUtils';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { FolderExplorer } from './FolderExplorer';
import { registerCommands } from './commands';

// Helper function to copy resources
async function copyResourceDirectory(
  context: vscode.ExtensionContext,
  resourceType: string,
  overwriteExisting: boolean = false,
) {
  const resourcesPath = path.join(
    context.extensionPath,
    'resources',
    resourceType,
  );
  const globalStoragePath = path.join(
    context.globalStorageUri.fsPath,
    resourceType,
  );

  console.log(`${resourceType} resources path:`, resourcesPath);
  console.log(`${resourceType} global storage path:`, globalStoragePath);

  try {
    // Ensure the global storage directory exists
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(globalStoragePath),
    );
    console.log(
      `Created or verified global storage directory for ${resourceType}`,
    );

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
        // Skip existing files if overwriteExisting is false
        if (!overwriteExisting && fs.existsSync(targetPath)) {
          console.log(`Skipping existing file: ${targetPath}`);
          return;
        }

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
    if (fs.existsSync(resourcesPath)) {
      await copyRecursively(resourcesPath, globalStoragePath);
      console.log(`Successfully copied ${resourceType} resources`);
    } else {
      console.log(`No ${resourceType} resources found at ${resourcesPath}`);
    }
  } catch (err) {
    console.error(`Error copying ${resourceType} resources:`, err);
  }
}

async function copyDefaultResources(context: vscode.ExtensionContext) {
  // Get current extension version from package.json
  const currentVersion = vscode.extensions.getExtension(context.extension.id)
    ?.packageJSON.version;
  const lastKnownVersion = context.globalState.get('lastKnownVersion');

  // Only proceed if version has changed
  if (currentVersion === lastKnownVersion) {
    console.log('Extension version unchanged, skipping resource copy');
    return;
  }

  console.log(
    `Extension version changed from ${lastKnownVersion} to ${currentVersion}, updating resources`,
  );

  // Copy resources
  // For agents, we overwrite existing files to ensure updates are applied
  await copyResourceDirectory(context, 'agents', true);
  // For replacements, we don't overwrite existing files to preserve user customizations
  await copyResourceDirectory(context, 'replacements', false);

  // Update the stored version after successful copy
  await context.globalState.update('lastKnownVersion', currentVersion);
  console.log('Updated stored extension version');
}

async function initializeReplacements(context: vscode.ExtensionContext) {
  try {
    // Load replacement definitions from YAML files
    const replacements = await loadReplacementDefinitions(context);

    // Set the replacement cache in replacementUtils
    setReplacementCache(replacements);

    console.log(`Loaded ${replacements.size} replacement categories`);
  } catch (err) {
    console.error('Error initializing replacements:', err);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Initialize secrets storage
  initializeSecrets(context);

  // Create the log view provider
  const progressViewProvider = new ProgressViewProvider(context);
  logger.setProgressViewProvider(progressViewProvider);

  // Copy default resources and load replacements
  copyDefaultResources(context).then(() => {
    initializeReplacements(context);
  });

  // Register commands first - this will create and store the CoAuthorViewProvider
  const registeredCommands = registerCommands(context);

  // Register the folder explorer with context
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const folderExplorer = new FolderExplorer(workspaceRoot, context);

  // Register the tree data provider and webview providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'coauthor.progressView',
      progressViewProvider,
    ),
    // Removed duplicate mainViewProvider registration since it's handled in commands.ts
    vscode.window.registerTreeDataProvider(
      'coauthor.folderExplorer',
      folderExplorer,
    ),
    // Add watcher for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('coauthor.explorer.agentsDirectory')) {
        folderExplorer.setupFileSystemWatcher();
        folderExplorer.refresh();
      }
    }),
    // Add disposable for cleanup
    { dispose: () => folderExplorer.dispose() },
  );
}

export function deactivate() {}
