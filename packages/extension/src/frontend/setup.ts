import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

import { promptExtensionInstall } from '@frontend/ui/instruction';
import { withLogChannel } from '@logger/effectLog';
import type { StateStore } from '@platform/interfaces';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { extendEnvPath } from '@utils/system/platformPaths';

const CHANNEL = 'extension';

/** Prepare the host environment and recommend LaTeX Workshop when useful.
 *  Never fails: each step logs its own failure and the next still runs. */
export function initializeLatexSupport(
  globalState: StateStore,
): Effect.Effect<void> {
  // Extend process.env.PATH with common TeX installation directories so that
  // child processes spawned by other extensions (e.g., LaTeX Workshop) can
  // find latexmk, pdflatex, and other TeX binaries.  When VS Code is launched
  // from the macOS Finder or Windows Start Menu it often inherits a minimal
  // PATH that excludes TeX directories, causing "spawn latexmk ENOENT" errors.
  const extendPath = Effect.sync(() => {
    const extendedPath = extendEnvPath(process.env.PATH);
    if (extendedPath === process.env.PATH) return false;
    process.env.PATH = extendedPath;
    return true;
  }).pipe(
    Effect.flatMap((extended) =>
      extended
        ? Effect.logInfo('Extended process PATH with TeX directories').pipe(
            withLogChannel(CHANNEL),
          )
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Failed to extend PATH with TeX directories: ${toErrorMessage(Cause.squash(cause))}`,
      ).pipe(withLogChannel(CHANNEL)),
    ),
  );

  const recommendLatexWorkshop = Effect.gen(function* () {
    const latexWorkshop = vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID);
    if (!latexWorkshop && (yield* workspaceContainsLatexFiles)) {
      // Only nag if the workspace actually contains LaTeX files; a user
      // evaluating TeXRA or using it on a non-LaTeX project should not be
      // prompted to install a TeX extension they don't need. They'll still
      // discover it via the LaTeX settings tab or compile errors later.
      yield* Effect.logInfo(
        'LaTeX Workshop extension not found, prompting installation',
      ).pipe(withLogChannel(CHANNEL));
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
      Effect.logError(
        `Error initializing LaTeX support: ${toErrorMessage(Cause.squash(cause))}`,
      ).pipe(withLogChannel(CHANNEL)),
    ),
  );

  return Effect.andThen(extendPath, recommendLatexWorkshop);
}

/** A failed search propagates: `initializeLatexSupport` logs it and skips the
 *  recommendation, rather than reading "the query failed" as "no .tex files". */
const workspaceContainsLatexFiles = Effect.tryPromise({
  try: async () =>
    vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 1),
  catch: ensureError,
}).pipe(Effect.map((hits) => hits.length > 0));
