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
import { DEFAULT_MODELS } from '@model/computeModelOptions';
import { GlobalStorageFS, StorageFS } from '@utils/files';
import { isConfigExplicitlySet, updateConfig } from '@utils/config';
import { extendEnvPath } from '@utils/system/platformPaths';

/**
 * Version number for the default model list.
 * Increment this when adding new models to force existing users to get the updated defaults.
 */
const MODEL_LIST_VERSION = 4;

/**
 * Version number for LaTeX-related VS Code config setup.
 * Increment this when changing which settings are auto-configured.
 */
const LATEX_CONFIG_VERSION = 1;

/** Extension ID for LaTeX Workshop */
const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

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
 */
export async function copyDefaultAgents(
  context: vscode.ExtensionContext,
): Promise<void> {
  StorageFS.initialize(context);

  const currentVersion = vscode.extensions.getExtension(context.extension.id)
    ?.packageJSON.version;
  const lastKnownVersion = globalSM.get<string>(
    GlobalStateKey.LAST_KNOWN_VERSION,
  );

  if (currentVersion === lastKnownVersion) {
    return;
  }

  try {
    await GlobalStorageFS.ensureDir('agents');
    await GlobalStorageFS.ensureDir('tool_use_agents');

    const resourcesBase = path.join(context.extensionPath, 'resources');
    await fsExtra.copy(
      path.join(resourcesBase, 'agents'),
      GlobalStorageFS.fullPath('agents'),
      { overwrite: true },
    );
    await fsExtra.copy(
      path.join(resourcesBase, 'tool_use_agents'),
      GlobalStorageFS.fullPath('tool_use_agents'),
      { overwrite: true },
    );

    await deleteLegacyAgentFiles();
    await globalSM.update(GlobalStateKey.LAST_KNOWN_VERSION, currentVersion);
  } catch (err) {
    logger.error(
      'extension',
      `Error copying default agents: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Deletes legacy agent files that have moved to remote-only
 */
async function deleteLegacyAgentFiles(): Promise<void> {
  for (const legacyFile of LEGACY_AGENT_FILES) {
    if (!(await GlobalStorageFS.exists(legacyFile))) {
      continue;
    }
    try {
      await GlobalStorageFS.delete(legacyFile);
      logger.info('extension', `Deleted legacy agent file: ${legacyFile}`);
    } catch (err) {
      logger.warn(
        'extension',
        `Failed to delete legacy agent file ${legacyFile}: ${toErrorMessage(err)}`,
      );
    }
  }
}

/**
 * Refreshes the model list when MODEL_LIST_VERSION changes.
 * Merges new default models into the user's existing enabled models list.
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
    await mergeNewModelsIfCustomized();
    await resetModelConfigsToDefaults();
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

/**
 * Merges new default models into user's existing enabled models list.
 */
async function mergeNewModelsIfCustomized(): Promise<void> {
  const currentModels = globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS);
  if (!currentModels) {
    logger.info(
      'extension',
      'No custom model list in globalSM, using defaults',
    );
    return;
  }

  const modelsToAdd = DEFAULT_MODELS.filter(
    (model) => !currentModels.includes(model),
  );

  if (modelsToAdd.length === 0) {
    return;
  }

  await globalSM.update(GlobalStateKey.ENABLED_MODELS, [
    ...currentModels,
    ...modelsToAdd,
  ]);
  logger.info(
    'extension',
    `Merged ${modelsToAdd.length} new models into user's list: ${modelsToAdd.join(', ')}`,
  );
}

/**
 * Resets model-related configs to undefined so package.json defaults apply
 */
async function resetModelConfigsToDefaults(): Promise<void> {
  const configsToReset = ['texra.merge.defaultModel'];

  for (const key of configsToReset) {
    if (isConfigExplicitlySet(key)) {
      await updateConfig(key, undefined, {
        target: vscode.ConfigurationTarget.Global,
      });
    }
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
export async function configureLatexSettings(): Promise<void> {
  // Extend process.env.PATH with common TeX installation directories so that
  // child processes spawned by other extensions (e.g., LaTeX Workshop) can
  // find latexmk, pdflatex, and other TeX binaries.  When VS Code is launched
  // from the macOS Finder or Windows Start Menu it often inherits a minimal
  // PATH that excludes TeX directories, causing "spawn latexmk ENOENT" errors.
  try {
    const extendedPath = extendEnvPath(process.env.PATH);
    if (extendedPath !== process.env.PATH) {
      process.env.PATH = extendedPath;
      logger.info('extension', 'Extended process PATH with TeX directories');
    }
  } catch (err) {
    logger.warn(
      'extension',
      `Failed to extend PATH with TeX directories: ${toErrorMessage(err)}`,
    );
  }

  try {
    const latexWorkshop = vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID);

    if (!latexWorkshop) {
      // Prompt has its own suppression — run every activation, not gated by version.
      await promptLatexWorkshopInstall();
      return;
    }

    // Only write VS Code config once per version bump
    const storedVersion = globalSM.get<number>(
      GlobalStateKey.LATEX_CONFIG_VERSION,
    );
    if (storedVersion === LATEX_CONFIG_VERSION) {
      return;
    }

    logger.info(
      'extension',
      'LaTeX Workshop extension detected, configuring settings',
    );

    // outDir, explorer.autoRevealExclude, and explorer.autoReveal are now
    // opt-in recommendations shown in the Settings > LaTeX tab.
    const settings: Array<[string, unknown]> = [
      [
        '[latex]',
        {
          'editor.wordWrap': 'on',
        },
      ],
    ];

    for (const [key, value] of settings) {
      await updateConfig(key, value, GLOBAL_IF_UNSET);
    }

    if (!vscode.env.appName?.toLowerCase().includes('windsurf')) {
      await updateConfig(
        'workbench.activityBar.location',
        'default',
        GLOBAL_IF_UNSET,
      );
      logger.info('extension', 'Activity bar location set to default');
    }

    await globalSM.update(
      GlobalStateKey.LATEX_CONFIG_VERSION,
      LATEX_CONFIG_VERSION,
    );
  } catch (err) {
    logger.error(
      'extension',
      `Error configuring LaTeX settings: ${toErrorMessage(err)}`,
    );
  }
}

async function promptLatexWorkshopInstall(): Promise<void> {
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
        callback: () =>
          safeExecuteCommand(
            'workbench.extensions.installExtension',
            [LATEX_WORKSHOP_EXT_ID],
            'extension',
          ),
      },
    ],
  );
}
