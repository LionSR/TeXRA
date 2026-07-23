import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import * as vscode from 'vscode';

import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
} from '@agent/index/AgentDirectorySync';
import {
  GlobalStateKey,
  WorkspaceStateKey,
  globalSM,
  workspaceSM,
} from '@common/state';
import { agentDirectories } from '@frontend/agents';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { LatexConfigValuesSchema } from '@shared/schemas/settingsViewMessages';
import {
  LATEX_FIELD_TO_KEY,
  LATEX_WORKSHOP_EXT_ID,
  type LatexConfigField,
} from '@shared/constants/latex';
import { updateConfig } from '@utils/config';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { registerExternalRoot } from '@utils/files/externalRoots';
import { extendEnvPath } from '@utils/system/platformPaths';

/**
 * Version number for LaTeX-related VS Code config setup.
 * Increment this when changing which settings are auto-configured.
 */
const LATEX_CONFIG_VERSION = 2;

/**
 * Reconciles bundled agents in global storage:
 *  - Always prunes renamed/removed legacy files (idempotent; cheap).
 *  - Refreshes bundled agents from packaged resources.
 *
 * Built-in agent directories are generated cache; user-owned edits belong in
 * custom agent directories.
 */
export async function copyDefaultAgents(
  context: vscode.ExtensionContext,
): Promise<void> {
  const currentVersion = vscode.extensions.getExtension(context.extension.id)
    ?.packageJSON.version;
  const sync = new BundledAgentDirectorySync({
    bundleSource: new PathAgentDirectoryBundleSource(
      path.join(context.extensionPath, 'resources'),
    ),
    storage: new GlobalStorageAgentDirectoryStorage(),
    versionStore: {
      get: () => globalSM.get<string>(GlobalStateKey.LAST_KNOWN_VERSION),
      update: (version) =>
        globalSM.update(GlobalStateKey.LAST_KNOWN_VERSION, version),
    },
    logger: {
      info: (message, data) => logger.info('extension', message, { data }),
      warn: (message, data) => logger.warn('extension', message, { data }),
    },
  });

  try {
    await sync.reconcile(currentVersion);
  } catch (err) {
    logger.error(
      'extension',
      `Error copying default agents: ${toErrorMessage(err)}`,
    );
  }
}

/** External-root registration options for the custom agents directory. */
const CUSTOM_AGENT_ROOT_OPTIONS = {
  kind: 'custom',
  writable: true,
  label: 'Custom agents',
} as const;

/**
 * Register agent directories + bundled reference docs with the external-roots
 * allowlist so the creator tool-use agent can read/write them through the
 * standard file tools (read_file, write_file, grep, glob, edit_file).
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
      registerExternalRoot(
        await agentDirectories.custom(),
        CUSTOM_AGENT_ROOT_OPTIONS,
      ),
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
    registerExternalRoot(custom, CUSTOM_AGENT_ROOT_OPTIONS);
  } catch (err) {
    logger.error(
      'extension',
      `Failed to refresh custom agents root: ${toErrorMessage(err)}`,
    );
  }
}

/** Default options for global settings that should only be set if not already configured */
const GLOBAL_IF_UNSET = {
  target: 'global',
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

    await updateConfig('[latex]', { 'editor.wordWrap': 'on' }, GLOBAL_IF_UNSET);

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

  const eq = isDeepStrictEqual;

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

/**
 * Read an explicit legacy `texra.*` value from VS Code config, considering
 * only workspaceFolder/workspace/global (never default). For keys deregistered
 * from `package.json` `contributes.configuration`, VS Code may not surface
 * settings.json entries via `inspect()`; fall back to `get(key)` for those.
 */
function readExplicitLegacyValue(
  cfg: vscode.WorkspaceConfiguration,
  key: WorkspaceStateKey,
): unknown {
  const inspection = cfg.inspect(key);
  if (inspection) {
    const explicit =
      inspection.workspaceFolderValue ??
      inspection.workspaceValue ??
      inspection.globalValue;
    if (explicit !== undefined) return explicit;
  }
  if (!inspection || inspection.defaultValue === undefined) {
    return cfg.get(key);
  }
  return undefined;
}

/**
 * Validate a legacy value against the new schema. Returns the parsed value
 * on success, or undefined when the value is unrecoverable. Permits one
 * backward-compat coercion: the old VS Code config `number` schema allowed
 * decimal timeouts where the new schema requires integers, so retry once
 * with `Math.round` before giving up.
 */
function validateLegacyLatexConfigValue(
  field: LatexConfigField,
  raw: unknown,
): unknown | undefined {
  const fieldSchema = LatexConfigValuesSchema.shape[field];
  const direct = fieldSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (
    typeof raw === 'number' &&
    Number.isFinite(raw) &&
    !Number.isInteger(raw)
  ) {
    const rounded = fieldSchema.safeParse(Math.round(raw));
    if (rounded.success) return rounded.data;
  }
  return undefined;
}

/**
 * One-shot per-workspace migration for LaTeX/compile/diff settings that moved
 * from `package.json` `contributes.configuration` to TeXRA workspace state.
 *
 * Gating: a single workspace-scoped marker (`LATEX_SETTINGS_MIGRATED`) is set
 * after the first run. Subsequent activations skip the entire pass. This is
 * essential for correctness — without a marker, a per-key "skip if storage has
 * any value" gate would re-import the legacy settings.json value the moment a
 * user resets a key to default via the LaTeX tab UI (`update(key, undefined)`
 * removes the key from storage; the next activation would read it back from
 * settings.json again). Marker prevents that footgun.
 *
 * Per-workspace, not per-user: workspace state is per-workspace and a global
 * once-per-user marker would let the first opened workspace consume the
 * migration and silently skip every other workspace.
 *
 * Source detection has two paths:
 * 1. `inspect()` — for keys that were declared in `contributes.configuration`
 *    at upgrade time. Considers only `workspaceFolderValue`, `workspaceValue`,
 *    `globalValue`, never `defaultValue` (avoids persisting VS Code's
 *    compiled-in defaults into workspace state, which would block future
 *    default changes).
 * 2. `get()` fallback — for users who upgrade directly past the package.json
 *    deregistration. VS Code may treat the now-unregistered keys' settings.json
 *    entries as opaque, so `inspect()` can return undefined or all-undefined.
 *    `get()` reads the merged config; for unregistered keys this is just the
 *    user's settings.json entry (no compiled-in default to confuse the result).
 *
 * Once migrated, the LaTeX tab UI writes to workspaceSM directly. A user who
 * later edits the legacy `texra.*` keys in settings.json sees no effect —
 * that path is no longer authoritative.
 */
export async function migrateLatexConfigToStorage(): Promise<void> {
  // One-shot gate. Once this workspace has been migrated, never run again —
  // post-migration the LaTeX tab UI is the only authoritative writer. Re-
  // running would re-import stale settings.json entries and silently undo
  // any "reset to default" the user performed in the UI.
  if (workspaceSM.get<boolean>(WorkspaceStateKey.LATEX_SETTINGS_MIGRATED)) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration();
  for (const [field, key] of Object.entries(LATEX_FIELD_TO_KEY) as [
    LatexConfigField,
    WorkspaceStateKey,
  ][]) {
    const raw = readExplicitLegacyValue(cfg, key);
    if (raw === undefined) continue;

    // Validate (with a one-shot decimal→integer coercion for legacy timeout
    // values). On failure: skip, log, do not write — the user's value falls
    // back to the documented default rather than crashing the webview parse
    // or sticking an out-of-range value into runtime readers.
    const validated = validateLegacyLatexConfigValue(field, raw);
    if (validated === undefined) {
      logger.warn(
        'extension',
        `Skipping migration of ${key}: value ${JSON.stringify(raw)} fails schema validation`,
      );
      continue;
    }

    try {
      await workspaceSM.update(key, validated);
      logger.info(
        'extension',
        `Migrated ${key} from VS Code config to workspace storage`,
      );
    } catch (err) {
      logger.warn(
        'extension',
        `Failed to migrate ${key} to workspace storage: ${toErrorMessage(err)}`,
      );
    }
  }

  // Always mark migration done — even if a particular key failed to copy or
  // had no value. Otherwise a transient failure would force a retry on every
  // activation forever, and the user's UI resets would be silently undone in
  // the meantime.
  try {
    await workspaceSM.update(WorkspaceStateKey.LATEX_SETTINGS_MIGRATED, true);
  } catch (err) {
    logger.warn(
      'extension',
      `Failed to set LATEX_SETTINGS_MIGRATED marker: ${toErrorMessage(err)}`,
    );
  }
}
