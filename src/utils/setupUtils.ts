// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// VS Code imports
import * as vscode from 'vscode';

// Local imports
import * as logger from '../logger/logUtils';

/**
 * Copies default agent files from the extension resources to the global storage directory
 * @param context The extension context
 */
export async function copyDefaultAgents(context: vscode.ExtensionContext) {
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

/**
 * Configure LaTeX-related workspace settings if LaTeX Workshop extension is installed
 */
export async function configureLatexSettings() {
  try {
    // Check if latex-workshop extension is installed
    const latexWorkshop = vscode.extensions.getExtension(
      'James-Yu.latex-workshop',
    );
    
    if (latexWorkshop) {
      logger.info(
        'extension',
        'LaTeX Workshop extension detected, configuring settings',
      );
      const config = vscode.workspace.getConfiguration();
      
      // Update LaTeX Workshop build settings
      await config.update(
        'latex-workshop.latex.external.build.args',
        ['--output-directory=build', '-f', '-pdf'],
        vscode.ConfigurationTarget.Global,
      );
      
      await config.update(
        'latex-workshop.latex.outDir',
        '%DIR%/build/',
        vscode.ConfigurationTarget.Global,
      );
      
      // Add nonstopmode magic arguments for LaTeX Workshop
      await config.update(
        'latex-workshop.latex.magic.args',
        [
          "-synctex=1",
          "-interaction=nonstopmode",
          "-file-line-error",
          "%DOC%",
          "-pdf",
          "-f"
        ],
        vscode.ConfigurationTarget.Global,
      );
      
      // Configure word wrap for LaTeX files
      await config.update(
        '[latex]',
        { 'editor.wordWrap': 'on' },
        vscode.ConfigurationTarget.Global,
      );
      
      // Also add word wrap for yaml files
      await config.update(
        '[yaml]',
        { 'editor.wordWrap': 'on' },
        vscode.ConfigurationTarget.Global,
      );
      
      // Check if the workbench.auxiliaryActivityBar.location setting exists
      const activityBarSetting = config.inspect('workbench.auxiliaryActivityBar.location');
      if (activityBarSetting) {
        // Setting exists, update it
        await config.update(
          'workbench.auxiliaryActivityBar.location',
          'default',
          vscode.ConfigurationTarget.Global,
        );
        logger.info('extension', 'Auxiliary activity bar location set to default');
      }
      
      logger.info(
        'extension',
        'LaTeX Workshop settings configured successfully',
      );
    } else {
      logger.info(
        'extension',
        'LaTeX Workshop extension not found, skipping configuration',
      );
    }
  } catch (err) {
    logger.error('extension', `Error configuring LaTeX settings: ${err}`);
  }
} 