import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
} from '@agent/index/AgentDirectorySync';
import { GlobalStateKey, globalSM } from '@common/state';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { promptExtensionInstall } from '@frontend/ui/instruction';
import * as logger from '@logger/logUtils';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latex';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { registerExternalRoot } from '@utils/files/externalRoots';
import { extendEnvPath } from '@utils/system/platformPaths';

/**
 * Reconciles bundled agents in global storage from packaged resources.
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

/** Prepare the host environment and recommend LaTeX Workshop when useful. */
export async function initializeLatexSupport(): Promise<void> {
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
        logger.info(
          'extension',
          'LaTeX Workshop extension not found, prompting installation',
        );
        await promptExtensionInstall({
          suppressKey: 'latex-workshop-install',
          message:
            'LaTeX Workshop extension is recommended for full TeXRA functionality (LaTeX compilation, PDF preview, and IntelliSense). Install now?',
          extensionId: LATEX_WORKSHOP_EXT_ID,
          channel: 'extension',
        });
      }
    }
  } catch (err) {
    logger.error(
      'extension',
      `Error initializing LaTeX support: ${toErrorMessage(err)}`,
    );
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
