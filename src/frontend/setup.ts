// Standard library imports
import * as path from 'path';

// VS Code imports
import * as vscode from 'vscode';

// Local imports
import * as logger from '@logger/logUtils';
import { AbsoluteFS, GlobalStorageFS, StorageFS } from '@utils/files';
import { GlobalStateKey, globalSM } from '@common/state/stateManager';

/**
 * Copies default agent files from the extension resources to the global storage directory
 * @param context The extension context
 */
export async function copyDefaultAgents(context: vscode.ExtensionContext) {
  // Initialize StorageFS with the context
  StorageFS.initialize(context);

  // Get current extension version from package.json
  const currentVersion = vscode.extensions.getExtension(context.extension.id)
    ?.packageJSON.version;
  const lastKnownVersion = globalSM.get<string>(
    GlobalStateKey.LAST_KNOWN_VERSION,
  );

  // Only proceed if version has changed
  if (currentVersion === lastKnownVersion) {
    console.log('Extension version unchanged, skipping agent copy');
    return;
  }

  console.log(
    `Extension version changed from ${lastKnownVersion} to ${currentVersion}, updating agents`,
  );

  const resourcesPath = path.join(context.extensionPath, 'resources', 'agents');
  const resourcesToolUse = path.join(
    context.extensionPath,
    'resources',
    'tool_use_agents',
  );
  const globalStoragePath = GlobalStorageFS.fullPath('agents');

  console.log('Resources path:', resourcesPath);
  console.log('Global storage path:', globalStoragePath);

  try {
    // Ensure the global storage agents directory exists
    await GlobalStorageFS.ensureDir('agents');
    await GlobalStorageFS.ensureDir('tool_use_agents');
    console.log('Created or verified global storage directory');

    // Recursive function to copy files and directories
    // Consider the native recursive copy available in Node 16+?
    const copyRecursively = async (
      sourcePath: string,
      targetRelativePath: string,
    ) => {
      const stats = AbsoluteFS.statSync(sourcePath);

      if (stats.isDirectory()) {
        await GlobalStorageFS.createDir(targetRelativePath);
        const files = AbsoluteFS.readDirSync(sourcePath);
        for (const file of files) {
          const sourceFilePath = path.join(sourcePath, file);
          const targetFileRelativePath = path.join(targetRelativePath, file);
          await copyRecursively(sourceFilePath, targetFileRelativePath);
        }
      } else {
        const content = AbsoluteFS.readBytesSync(sourcePath);
        await GlobalStorageFS.write(targetRelativePath, content);
      }
    };

    // Start recursive copy from root
    await copyRecursively(resourcesPath, 'agents');
    await copyRecursively(resourcesToolUse, 'tool_use_agents');

    // Update the stored version after successful copy
    await globalSM.update(GlobalStateKey.LAST_KNOWN_VERSION, currentVersion);
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
          '-synctex=1',
          '-interaction=nonstopmode',
          '-file-line-error',
          '%DOC%',
          '-pdf',
          '-f',
        ],
        vscode.ConfigurationTarget.Global,
      );

      // Configure LaTeX formatting
      await config.update(
        'latex-workshop.formatting.latex',
        'latexindent',
        vscode.ConfigurationTarget.Global,
      );

      // Configure word wrap for LaTeX files
      await config.update(
        '[latex]',
        { 'editor.wordWrap': 'on', 'files.autoSave': 'afterDelay' },
        vscode.ConfigurationTarget.Global,
      );

      // Also add word wrap for yaml files
      await config.update(
        '[yaml]',
        { 'editor.wordWrap': 'on', 'files.autoSave': 'afterDelay' },
        vscode.ConfigurationTarget.Global,
      );

      // Configure explorer settings to not automatically reveal build directory
      await config.update(
        'explorer.autoRevealExclude',
        { 'build/': true },
        vscode.ConfigurationTarget.Global,
      );

      // Disable automatic revealing of files in explorer
      await config.update(
        'explorer.autoReveal',
        false,
        vscode.ConfigurationTarget.Global,
      );

      const isWindsurf = vscode.env.appName?.toLowerCase().includes('windsurf');

      if (!isWindsurf) {
        const activityBarKey = 'workbench.activityBar.location';

        // Check if the activity bar location setting exists
        const activityBarSetting = config.inspect(activityBarKey);
        if (activityBarSetting) {
          // Setting exists, update it
          await config.update(
            activityBarKey,
            'default',
            vscode.ConfigurationTarget.Global,
          );
          logger.info('extension', 'Activity bar location set to default');
        }
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
