import { Effect } from 'effect';
import * as vscode from 'vscode';

import { withLogChannel, type StateStore } from '@texra-ai/worldline/plugins';
import { withCommandDirs } from '@texra-ai/worldline/node';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
import { askNotice } from '@frontend/hosts/VscodeUiHost';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { vscodeEditorIntegration } from '@frontend/vscodeEditorIntegration';
import { fromHost } from '@texra/controllers/session/hostCallFailure';
import { askUnlessSilenced } from '@texra/controllers/session/windowNotices';
import {
  LATEX_WORKSHOP_EXT_ID,
  LATEX_WORKSHOP_FEATURES,
} from '@texra/shared/constants/latexToolchain';

const CHANNEL = 'extension';
const INSTALL = 'Install';

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
  const extendPath = Effect.map(
    withCommandDirs({ PATH: process.env.PATH }),
    ({ PATH: extendedPath }) => {
      if (extendedPath === process.env.PATH) return false;
      process.env.PATH = extendedPath;
      return true;
    },
  ).pipe(
    Effect.flatMap((extended) =>
      extended
        ? Effect.logInfo('Extended process PATH with TeX directories').pipe(
            withLogChannel(CHANNEL),
          )
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Failed to extend PATH with TeX directories: ${toErrorMessage(cause)}`,
      ).pipe(withLogChannel(CHANNEL)),
    ),
  );

  const recommendLatexWorkshop = Effect.gen(function* () {
    if (
      !vscodeEditorIntegration.installed(LATEX_WORKSHOP_EXT_ID) &&
      (yield* workspaceContainsLatexFiles)
    ) {
      // Only nag if the workspace actually contains LaTeX files; a user
      // evaluating TeXRA or using it on a non-LaTeX project should not be
      // prompted to install a TeX extension they don't need. They'll still
      // discover it via the LaTeX settings tab or compile errors later.
      yield* Effect.logInfo(
        'LaTeX Workshop extension not found, prompting installation',
      );
      const choice = yield* askUnlessSilenced(
        askNotice,
        globalState,
        'latex-workshop-install',
        `Install LaTeX Workshop for ${LATEX_WORKSHOP_FEATURES}?`,
        [INSTALL],
      );
      if (choice !== INSTALL) return;
      // A refused install is reported once, on this channel.
      yield* vscodeEditorIntegration
        .install(LATEX_WORKSHOP_EXT_ID)
        .pipe(
          Effect.catch((err) =>
            showLoggedErrorMessage(
              'Could not install LaTeX Workshop',
              err,
            ).pipe(Effect.asVoid),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(
        `Error initializing LaTeX support: ${toErrorMessage(cause)}`,
      ),
    ),
    withLogChannel(CHANNEL),
  );

  return Effect.andThen(extendPath, recommendLatexWorkshop);
}

/** A failed search propagates: `initializeLatexSupport` logs it and skips the
 *  recommendation, rather than reading "the query failed" as "no .tex files". */
const workspaceContainsLatexFiles = fromHost('workspace.findFiles', async () =>
  vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 1),
).pipe(Effect.map((hits) => hits.length > 0));
