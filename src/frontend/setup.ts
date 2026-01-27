// Standard library imports
import * as path from 'path';

// Third-party imports
import fsExtra from 'fs-extra';

// VS Code imports
import * as vscode from 'vscode';

// Local imports
import { toErrorMessage } from '@common/errors';
import { GlobalStateKey, globalSM } from '@common/state';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { GlobalStorageFS, StorageFS } from '@utils/files';
import { getConfig, updateConfig } from '@utils/config';

/**
 * Version number for the default model list.
 * Increment this when adding new models to force existing users to get the updated defaults.
 */
const MODEL_LIST_VERSION = 2;

/**
 * Legacy agent files that should be deleted from GlobalStorage.
 * These agents have moved to remote-only and should not exist locally.
 */
const LEGACY_AGENT_FILES = [
  'agents/generic.yaml',
  'agents/generic_multiple.yaml',
];

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
    return;
  }

  const resourcesPath = path.join(context.extensionPath, 'resources', 'agents');
  const resourcesToolUse = path.join(
    context.extensionPath,
    'resources',
    'tool_use_agents',
  );
  try {
    // Ensure the global storage agents directory exists
    await GlobalStorageFS.ensureDir('agents');
    await GlobalStorageFS.ensureDir('tool_use_agents');

    // Start recursive copy from root
    await fsExtra.copy(resourcesPath, GlobalStorageFS.fullPath('agents'), {
      overwrite: true,
    });
    await fsExtra.copy(
      resourcesToolUse,
      GlobalStorageFS.fullPath('tool_use_agents'),
      { overwrite: true },
    );

    // Clean up legacy agent files that have moved to remote-only
    for (const legacyFile of LEGACY_AGENT_FILES) {
      try {
        if (await GlobalStorageFS.exists(legacyFile)) {
          await GlobalStorageFS.delete(legacyFile);
          logger.info('extension', `Deleted legacy agent file: ${legacyFile}`);
        }
      } catch (err) {
        logger.warn(
          'extension',
          `Failed to delete legacy agent file ${legacyFile}: ${toErrorMessage(err)}`,
        );
      }
    }

    // Update the stored version after successful copy
    await globalSM.update(GlobalStateKey.LAST_KNOWN_VERSION, currentVersion);
  } catch (err) {
    logger.error(
      'extension',
      `Error copying default agents: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Default models that should be present in every user's model list.
 * IMPORTANT: This must match the "default" array in package.json under "texra.models".
 * Update this list and increment MODEL_LIST_VERSION when adding new models.
 */
const DEFAULT_MODELS = [
  'gemini3p',
  'sonnet45T',
  'opus45T',
  'gpt52',
  'gpt52pro',
  'gpt41',
  'deepseekT',
  'kimi2T',
  'kimi2',
  'qwen3max',
  'grok4',
];

/**
 * Checks if a configuration setting has been explicitly set by the user
 * (at global or workspace level), rather than using package.json defaults.
 */
function isConfigExplicitlySet(key: string): boolean {
  const inspection = vscode.workspace.getConfiguration().inspect(key);
  return (
    inspection?.globalValue !== undefined ||
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined
  );
}

/**
 * Refreshes the model list when MODEL_LIST_VERSION changes.
 * - If user hasn't customized settings: resets to undefined so package.json defaults apply
 * - If user has customized: merges new default models into their list
 */
export async function refreshModelListIfNeeded(): Promise<void> {
  const storedVersion = globalSM.get<number>(GlobalStateKey.MODEL_LIST_VERSION);

  if (storedVersion === MODEL_LIST_VERSION) {
    return;
  }

  logger.info(
    'extension',
    `Model list version changed (${storedVersion ?? 'none'} -> ${MODEL_LIST_VERSION}), updating model list`,
  );

  try {
    // Check if user has explicitly customized their model list
    if (isConfigExplicitlySet('texra.models')) {
      // User has customized - merge new defaults into their list
      const currentModels = getConfig<string[]>('models', []);

      const modelsToAdd = DEFAULT_MODELS.filter(
        (model) => !currentModels.includes(model),
      );

      if (modelsToAdd.length > 0) {
        const mergedModels = [...currentModels, ...modelsToAdd];
        await updateConfig('texra.models', mergedModels, {
          target: vscode.ConfigurationTarget.Global,
        });
        logger.info(
          'extension',
          `Merged ${modelsToAdd.length} new models into user's list: ${modelsToAdd.join(', ')}`,
        );
      }
    } else {
      // User hasn't customized - reset to undefined so package.json defaults apply
      logger.info(
        'extension',
        'User has not customized model list, using package.json defaults',
      );
    }

    // Reset instructionPolishModel and merge.defaultModel to undefined
    // so they use package.json defaults (which now include new models in enums)
    if (isConfigExplicitlySet('texra.model.instructionPolishModel')) {
      await updateConfig('texra.model.instructionPolishModel', undefined, {
        target: vscode.ConfigurationTarget.Global,
      });
    }
    if (isConfigExplicitlySet('texra.merge.defaultModel')) {
      await updateConfig('texra.merge.defaultModel', undefined, {
        target: vscode.ConfigurationTarget.Global,
      });
    }

    await globalSM.update(
      GlobalStateKey.MODEL_LIST_VERSION,
      MODEL_LIST_VERSION,
    );
    logger.info('extension', 'Model list refresh completed successfully');
  } catch (err) {
    logger.error(
      'extension',
      `Failed to refresh model list: ${toErrorMessage(err)}`,
    );
  }
}

/** Default options for global settings that should only be set if not already configured */
const GLOBAL_IF_UNSET = {
  target: vscode.ConfigurationTarget.Global,
  prefix: false,
  ifUnset: true,
} as const;

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

      // Define all settings to configure
      const settings: Array<[string, unknown]> = [
        // LaTeX Workshop build settings
        // Run builds from workspace folder so relative paths resolve consistently
        ['latex-workshop.latex.build.fromWorkspaceFolder', true],
        [
          'latex-workshop.latex.external.build.args',
          ['--output-directory=build', '-f', '-pdf'],
        ],
        ['latex-workshop.latex.outDir', '%DIR%/build/'],
        [
          'latex-workshop.latex.magic.args',
          [
            '-synctex=1',
            '-interaction=nonstopmode',
            '-file-line-error',
            '%DOC%',
            '-pdf',
            '-f',
          ],
        ],
        ['latex-workshop.formatting.latex', 'latexindent'],
        // Language-specific editor settings
        [
          '[latex]',
          { 'editor.wordWrap': 'on', 'files.autoSave': 'afterDelay' },
        ],
        ['[latex]', { 'intellisense.update.delay': 1000 }],
        ['[yaml]', { 'editor.wordWrap': 'on', 'files.autoSave': 'afterDelay' }],
        // Explorer settings
        ['explorer.autoRevealExclude', { 'build/': true }],
        ['explorer.autoReveal', false],
      ];

      // Apply all settings
      for (const [key, value] of settings) {
        await updateConfig(key, value, GLOBAL_IF_UNSET);
      }

      const isWindsurf = vscode.env.appName?.toLowerCase().includes('windsurf');

      if (!isWindsurf) {
        await updateConfig(
          'workbench.activityBar.location',
          'default',
          GLOBAL_IF_UNSET,
        );
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
    logger.error(
      'extension',
      `Error configuring LaTeX settings: ${toErrorMessage(err)}`,
    );
  }
}
