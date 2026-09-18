import * as path from 'node:path';

import { Cause, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { promptExtensionInstall } from '@frontend/ui/instruction';
import { createLog } from '@logger/logUtils';
import type { AgentDirectoriesFailed, StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { registerExternalRoot } from '@utils/files/externalRoots';
import { extendEnvPath } from '@utils/system/platformPaths';

const log = createLog('extension');

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
 * The built-in directories are the packaged ones, so this only needs the
 * extension's resources path to be resolvable.
 */
export function registerAgentDirectoryRoots(
  context: vscode.ExtensionContext,
): Effect.Effect<void, never, GlobalStorageFs | FileSystem.FileSystem> {
  const registrations: Array<
    Effect.Effect<
      void,
      AgentDirectoriesFailed,
      GlobalStorageFs | FileSystem.FileSystem
    >
  > = [
    Effect.flatMap(agentDirectories.builtIn(), (directory) =>
      Effect.sync(() =>
        registerExternalRoot(directory, {
          kind: 'builtInWorkflow',
          writable: false,
          label: 'Built-in workflow agents',
        }),
      ),
    ),
    Effect.flatMap(agentDirectories.builtInToolUse(), (directory) =>
      Effect.sync(() =>
        registerExternalRoot(directory, {
          kind: 'builtInToolUse',
          writable: false,
          label: 'Built-in tool-use agents',
        }),
      ),
    ),
    Effect.flatMap(agentDirectories.custom(), (directory) =>
      Effect.sync(() =>
        registerExternalRoot(directory, CUSTOM_AGENT_ROOT_OPTIONS),
      ),
    ),
    Effect.sync(() =>
      registerExternalRoot(
        path.join(context.extensionPath, 'resources', 'docs', 'agent-creation'),
        {
          kind: 'agentDocs',
          writable: false,
          label: 'Agent creation docs',
        },
      ),
    ),
  ];

  // Register each root independently so one failing directory resolution
  // (e.g. a misconfigured custom agents path) does not take out the others —
  // the creator agent still needs its reference docs and built-in examples.
  return Effect.forEach(
    registrations,
    (register) =>
      register.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.error(
              `Failed to register agent directory root: ${toErrorMessage(Cause.squash(cause))}`,
            );
          }),
        ),
      ),
    { discard: true },
  );
}

/**
 * Re-register the custom agents directory after the user changes its
 * location via Settings. Registering the same `kind` overwrites the
 * previous slot, so no separate unregister step is needed.
 */
export function refreshCustomAgentRoot(): Effect.Effect<
  void,
  never,
  GlobalStorageFs | FileSystem.FileSystem
> {
  return agentDirectories.custom().pipe(
    Effect.andThen((custom) =>
      Effect.sync(() =>
        registerExternalRoot(custom, CUSTOM_AGENT_ROOT_OPTIONS),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        log.error(
          `Failed to refresh custom agents root: ${toErrorMessage(Cause.squash(cause))}`,
        );
      }),
    ),
  );
}

/** Prepare the host environment and recommend LaTeX Workshop when useful.
 *  Runs on the runtime `activate` holds, threaded in by its one caller. */
export async function initializeLatexSupport(
  globalState: StateStore,
  runtime: ProcessRuntime,
): Promise<void> {
  // Extend process.env.PATH with common TeX installation directories so that
  // child processes spawned by other extensions (e.g., LaTeX Workshop) can
  // find latexmk, pdflatex, and other TeX binaries.  When VS Code is launched
  // from the macOS Finder or Windows Start Menu it often inherits a minimal
  // PATH that excludes TeX directories, causing "spawn latexmk ENOENT" errors.
  await runtime.runPromise(
    Effect.sync(() => {
      const extendedPath = extendEnvPath(process.env.PATH);
      if (extendedPath !== process.env.PATH) {
        process.env.PATH = extendedPath;
        log.info('Extended process PATH with TeX directories');
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log.warn(
            `Failed to extend PATH with TeX directories: ${toErrorMessage(Cause.squash(cause))}`,
          );
        }),
      ),
    ),
  );

  await runtime.runPromise(
    Effect.gen(function* () {
      const latexWorkshop = vscode.extensions.getExtension(
        LATEX_WORKSHOP_EXT_ID,
      );

      if (
        !latexWorkshop &&
        (yield* Effect.promise(workspaceContainsLatexFiles))
      ) {
        // Only nag if the workspace actually contains LaTeX files; a user
        // evaluating TeXRA or using it on a non-LaTeX project should not be
        // prompted to install a TeX extension they don't need. They'll still
        // discover it via the LaTeX settings tab or compile errors later.
        log.info('LaTeX Workshop extension not found, prompting installation');
        yield* promptExtensionInstall(globalState, {
          suppressKey: 'latex-workshop-install',
          message:
            'LaTeX Workshop extension is recommended for full TeXRA functionality (LaTeX compilation, PDF preview, and IntelliSense). Install now?',
          extensionId: LATEX_WORKSHOP_EXT_ID,
          channel: 'extension',
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log.error(
            `Error initializing LaTeX support: ${toErrorMessage(Cause.squash(cause))}`,
          );
        }),
      ),
    ),
  );
}

/** A failed search propagates: `initializeLatexSupport` logs it and skips the
 *  recommendation, rather than reading "the query failed" as "no .tex files". */
async function workspaceContainsLatexFiles(): Promise<boolean> {
  const hits = await vscode.workspace.findFiles(
    '**/*.tex',
    '**/node_modules/**',
    1,
  );
  return hits.length > 0;
}
