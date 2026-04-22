import * as path from 'path';

import fsExtra from 'fs-extra';
import * as vscode from 'vscode';

import { toErrorMessage } from '@common/errors';
import { GlobalStateKey, globalSM } from '@common/state';
import { agentDirectories } from '@frontend/agents';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { DEFAULT_MODELS, MODEL_LIST_VERSION } from '@model/computeModelOptions';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latex';
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';
import { GlobalStorageFS } from '@utils/files';
import { isConfigExplicitlySet, updateConfig } from '@utils/config';
import { registerExternalRoot } from '@utils/files/externalRoots';
import { extendEnvPath } from '@utils/system/platformPaths';

/**
 * Version number for LaTeX-related VS Code config setup.
 * Increment this when changing which settings are auto-configured.
 */
const LATEX_CONFIG_VERSION = 2;

/**
 * Legacy agent files that should be deleted from GlobalStorage.
 * These agents have moved to remote-only and should not exist locally.
 */
const LEGACY_AGENT_FILES = [
  'agents/generic.yaml',
  'agents/generic_multiple.yaml',
];

/**
 * Seed the disabled-tool list for first-time users only.
 *
 * Every tool group flagged `toggleable: true` in EXTERNAL_TOOL_DEFS is
 * treated as opt-in and seeded as disabled on a fresh install. Runs before
 * `copyDefaultAgents` (which writes `LAST_KNOWN_VERSION`); the combined
 * absence of that key and `DISABLED_TOOLS` is how we detect a new install
 * — existing upgrading users keep their list.
 */
export async function initializeToolDefaults(): Promise<void> {
  const lastKnownVersion = globalSM.get<string>(
    GlobalStateKey.LAST_KNOWN_VERSION,
  );
  const disabledTools = globalSM.get<string[]>(GlobalStateKey.DISABLED_TOOLS);

  if (lastKnownVersion !== undefined || disabledTools !== undefined) {
    return;
  }

  const defaults = EXTERNAL_TOOL_DEFS.filter((def) => def.toggleable).map(
    (def) => def.id,
  );
  await globalSM.update(GlobalStateKey.DISABLED_TOOLS, defaults);
  logger.info(
    'extension',
    `First install — default-disabled toggleable tools: ${defaults.join(', ')}`,
  );
}

/**
 * Copies default agent files from the extension resources to the global storage directory
 */
export async function copyDefaultAgents(
  context: vscode.ExtensionContext,
): Promise<void> {
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
 * Register agent directories + bundled reference docs with the external-roots
 * allowlist so the creator tool-use agent can read/write them through the
 * standard file tools (read_file, write_file, ls, grep, glob, edit_file).
 *
 * Call this after copyDefaultAgents(), which populates the built-in dirs.
 */
export async function registerAgentDirectoryRoots(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Register each root independently so one failing directory resolution
  // (e.g. a misconfigured custom agents path) does not take out the others —
  // the creator agent still needs its reference docs and built-in examples.
  const registrations: Array<() => Promise<void> | void> = [
    async () =>
      registerExternalRoot(await agentDirectories.builtIn(), {
        kind: 'builtInWorkflow',
        writable: false,
        label: 'Built-in workflow agents',
      }),
    async () =>
      registerExternalRoot(await agentDirectories.builtInToolUse(), {
        kind: 'builtInToolUse',
        writable: false,
        label: 'Built-in tool-use agents',
      }),
    async () =>
      registerExternalRoot(await agentDirectories.custom(), {
        kind: 'custom',
        writable: true,
        label: 'Custom agents',
      }),
    () =>
      registerExternalRoot(
        path.join(context.extensionPath, 'resources', 'docs', 'agent-creation'),
        {
          kind: 'agentDocs',
          writable: false,
          label: 'Agent creation docs',
        },
      ),
  ];

  await Promise.all(
    registrations.map(async (register) => {
      try {
        await register();
      } catch (err) {
        logger.error(
          'extension',
          `Failed to register agent directory root: ${toErrorMessage(err)}`,
        );
      }
    }),
  );
}

/**
 * Re-register the custom agents directory after the user changes its
 * location via Settings. Registering the same `kind` overwrites the
 * previous slot, so no separate unregister step is needed.
 */
export async function refreshCustomAgentRoot(): Promise<void> {
  try {
    const custom = await agentDirectories.custom();
    registerExternalRoot(custom, {
      kind: 'custom',
      writable: true,
      label: 'Custom agents',
    });
  } catch (err) {
    logger.error(
      'extension',
      `Failed to refresh custom agents root: ${toErrorMessage(err)}`,
    );
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
      // Only nag if the workspace actually contains LaTeX files; a user
      // evaluating TeXRA or using it on a non-LaTeX project should not be
      // prompted to install a TeX extension they don't need. They'll still
      // discover it via the LaTeX settings tab or compile errors later.
      if (await workspaceContainsLatexFiles()) {
        await promptLatexWorkshopInstall();
      }
      return;
    }

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

    if (storedVersion === undefined || storedVersion < 2) {
      await resetLegacyLatexSettings();
    }

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

/**
 * Reset settings that older TeXRA versions (< v0.37) auto-wrote on every activation.
 * Only resets a setting if its current global value matches what TeXRA set,
 * so user customizations are preserved.
 */
async function resetLegacyLatexSettings(): Promise<void> {
  const GLOBAL = vscode.ConfigurationTarget.Global;
  const cfg = vscode.workspace.getConfiguration();

  // Deep equality check for arrays/objects
  const eq = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  // Simple settings: reset to undefined if value matches what TeXRA wrote.
  const legacySettings: Array<[string, unknown]> = [
    ['latex-workshop.latex.build.fromWorkspaceFolder', true],
    [
      'latex-workshop.latex.external.build.args',
      ['--output-directory=build', '-f', '-pdf'],
    ],
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
    ['explorer.autoReveal', false],
  ];

  for (const [key, oldValue] of legacySettings) {
    const inspection = cfg.inspect(key);
    if (
      inspection?.globalValue !== undefined &&
      eq(inspection.globalValue, oldValue)
    ) {
      await cfg.update(key, undefined, GLOBAL);
      logger.info('extension', `Reset legacy setting: ${key}`);
    }
  }

  // Language-scoped settings: remove only the keys TeXRA added.
  const legacyLanguageKeys: Array<[string, Record<string, unknown>]> = [
    [
      '[latex]',
      { 'files.autoSave': 'afterDelay', 'intellisense.update.delay': 1000 },
    ],
    ['[yaml]', { 'editor.wordWrap': 'on', 'files.autoSave': 'afterDelay' }],
  ];

  for (const [langKey, oldKeys] of legacyLanguageKeys) {
    const inspection = cfg.inspect<Record<string, unknown>>(langKey);
    const current = inspection?.globalValue;
    if (!current || typeof current !== 'object') continue;

    const cleaned = { ...current };
    let changed = false;
    for (const [k, v] of Object.entries(oldKeys)) {
      if (eq(cleaned[k], v)) {
        delete cleaned[k];
        changed = true;
      }
    }
    if (changed) {
      const newValue = Object.keys(cleaned).length > 0 ? cleaned : undefined;
      await cfg.update(langKey, newValue, GLOBAL);
      logger.info('extension', `Cleaned legacy keys from ${langKey}`);
    }
  }
}

async function workspaceContainsLatexFiles(): Promise<boolean> {
  try {
    const hits = await vscode.workspace.findFiles(
      '**/*.tex',
      '**/node_modules/**',
      1,
    );
    return hits.length > 0;
  } catch {
    return false;
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
