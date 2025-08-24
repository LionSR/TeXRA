// Standard library imports
import * as path from 'path';

// VS Code imports
import * as vscode from 'vscode';

// Local imports
import * as logger from '@logger/logUtils';
import { GlobalStorageFS, StorageFS, copyDirToFS } from '@utils/files';
import { GlobalStateKey, globalSM } from '@common/state/stateManager';
import { safeExecuteCommand } from '@utils/system';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';

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

    // Start recursive copy from root
    await copyDirToFS(resourcesPath, 'agents', GlobalStorageFS);
    await copyDirToFS(resourcesToolUse, 'tool_use_agents', GlobalStorageFS);

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

      // Helper to update LaTeX Workshop settings only when unset
      const updateIfUnset = async <T>(key: string, value: T) => {
        const setting = config.inspect<T>(key);
        if (
          setting &&
          setting.globalValue === undefined &&
          setting.workspaceValue === undefined &&
          setting.workspaceFolderValue === undefined
        ) {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
        }
      };

      // Update LaTeX Workshop build settings
      await updateIfUnset<string[]>(
        'latex-workshop.latex.external.build.args',
        ['--output-directory=build', '-f', '-pdf'],
      );

      await updateIfUnset<string>(
        'latex-workshop.latex.outDir',
        '%DIR%/build/',
      );

      // Add nonstopmode magic arguments for LaTeX Workshop
      await updateIfUnset<string[]>('latex-workshop.latex.magic.args', [
        '-synctex=1',
        '-interaction=nonstopmode',
        '-file-line-error',
        '%DOC%',
        '-pdf',
        '-f',
      ]);

      // Configure LaTeX formatting
      await updateIfUnset<string>(
        'latex-workshop.formatting.latex',
        'latexindent',
      );

      // Configure word wrap for LaTeX files
      await updateIfUnset('[latex]', {
        'editor.wordWrap': 'on',
        'files.autoSave': 'afterDelay',
      });

      // Also add word wrap for yaml files
      await updateIfUnset('[yaml]', {
        'editor.wordWrap': 'on',
        'files.autoSave': 'afterDelay',
      });

      // Configure explorer settings to not automatically reveal build directory
      await updateIfUnset('explorer.autoRevealExclude', { 'build/': true });

      // Disable automatic revealing of files in explorer
      await updateIfUnset('explorer.autoReveal', false);

      const isWindsurf = vscode.env.appName?.toLowerCase().includes('windsurf');

      if (!isWindsurf) {
        const activityBarKey = 'workbench.activityBar.location';

        // Update activity bar location only if unset
        await updateIfUnset(activityBarKey, 'default');
        logger.info('extension', 'Activity bar location set to default');
      }

      logger.info(
        'extension',
        'LaTeX Workshop settings configured successfully',
      );
    } else {
      logger.info(
        'extension',
        'LaTeX Workshop extension not found, prompting installation',
      );
      await showInstructionWithSuppress(
        'latex-workshop-install',
        'LaTeX Workshop extension is recommended for full TeXRA functionality (LaTeX compilation, PDF preview, and IntelliSense). Install now?',
        [
          {
            title: 'Install',
            callback: async () => {
              await safeExecuteCommand(
                'workbench.extensions.installExtension',
                ['James-Yu.latex-workshop'],
                'extension',
              );
            },
          },
        ],
      );
    }
  } catch (err) {
    logger.error('extension', `Error configuring LaTeX settings: ${err}`);
  }
}
