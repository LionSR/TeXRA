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
import { getConfig, isConfigExplicitlySet, updateConfig } from '@utils/config';

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
 * Refreshes the model list when MODEL_LIST_VERSION changes.
 * - If user hasn't customized settings: package.json defaults apply automatically
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
 * Merges new default models into user's list if they've customized it
 */
async function mergeNewModelsIfCustomized(): Promise<void> {
  if (!isConfigExplicitlySet('texra.models')) {
    logger.info(
      'extension',
      'User has not customized model list, using package.json defaults',
    );
    return;
  }

  const currentModels = getConfig<string[]>('models', []);
  const modelsToAdd = DEFAULT_MODELS.filter(
    (model) => !currentModels.includes(model),
  );

  if (modelsToAdd.length === 0) {
    return;
  }

  await updateConfig('texra.models', [...currentModels, ...modelsToAdd], {
    target: vscode.ConfigurationTarget.Global,
  });
  logger.info(
    'extension',
    `Merged ${modelsToAdd.length} new models into user's list: ${modelsToAdd.join(', ')}`,
  );
}

/**
 * Resets model-related configs to undefined so package.json defaults apply
 */
async function resetModelConfigsToDefaults(): Promise<void> {
  const configsToReset = [
    'texra.model.instructionPolishModel',
    'texra.merge.defaultModel',
  ];

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
  try {
    const latexWorkshop = vscode.extensions.getExtension(
      'James-Yu.latex-workshop',
    );

    if (!latexWorkshop) {
      await promptLatexWorkshopInstall();
      return;
    }

    logger.info(
      'extension',
      'LaTeX Workshop extension detected, configuring settings',
    );

    const settings: Array<[string, unknown]> = [
      // LaTeX Workshop build settings
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
        {
          'editor.wordWrap': 'on',
          'files.autoSave': 'afterDelay',
          'intellisense.update.delay': 1000,
        },
      ],
      ['[yaml]', { 'editor.wordWrap': 'on', 'files.autoSave': 'afterDelay' }],
      // Explorer settings
      ['explorer.autoRevealExclude', { 'build/': true }],
      ['explorer.autoReveal', false],
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

    logger.info('extension', 'LaTeX Workshop settings configured successfully');
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
            ['James-Yu.latex-workshop'],
            'extension',
          ),
      },
    ],
  );
}
