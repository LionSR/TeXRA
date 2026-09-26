// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  findBuildDirectories,
  removeBuildDirectories,
} from '@housekeeping/clean';
import { fileOpResultMessage, runCleanRunDir } from '@housekeeping/runDirOps';
import { withLogChannel } from '@logger/effectLog';

import type { FileOpResult } from '@shared/schemas';
import { type CleanConfig } from './fileOpSchemas';

const CHANNEL = 'cleanCommands';

const showCleanResult = (
  result: FileOpResult,
  inputFile: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { level, text } = fileOpResultMessage('clean', result, inputFile);
    if (result.status === 'missingParams') {
      yield* Effect.forkDetach(showLoggedMessage(CHANNEL, text));
    } else if (level === 'error') {
      void vscode.window.showErrorMessage(text);
    } else {
      void vscode.window.showInformationMessage(text);
    }
  });

/** Clean removes a run's own storage; without a run there is nothing to clean. */
export const handleClean = Effect.fn('cleanCommands.handleClean')(function* (
  config: CleanConfig,
) {
  yield* Effect.logDebug(
    `Clean command called with config: ${JSON.stringify(config)}`,
  ).pipe(withLogChannel(CHANNEL));
  const result: FileOpResult = config.runId
    ? yield* runCleanRunDir(config.runId)
    : { status: 'noFiles' };
  yield* showCleanResult(result, config.inputFile);
});

const LISTED_BUILD_DIRECTORIES = 10;

/**
 * `texra.cleanBuild`: list every `build/` folder the command would delete,
 * ask once in a modal that names them, then report what happened. The
 * deletion is recursive and workspace-wide, so it never runs on one click.
 */
export const confirmCleanBuild = Effect.gen(function* () {
  const directories = yield* findBuildDirectories;
  if (directories.length === 0) {
    void vscode.window.showInformationMessage(
      'No build/ folders found in this workspace.',
    );
    return;
  }
  const listed = directories.slice(0, LISTED_BUILD_DIRECTORIES);
  const more = directories.length - listed.length;
  const detail = [
    ...listed.map((dir) => `${dir}/`),
    ...(more > 0 ? [`…and ${more} more`] : []),
  ].join('\n');
  const noun = directories.length === 1 ? 'folder' : 'folders';
  const confirm = `Delete ${directories.length} ${noun}`;
  const choice = yield* Effect.promise(() =>
    vscode.window.showWarningMessage(
      `Delete ${directories.length} build/ ${noun} and everything in them?`,
      { modal: true, detail },
      confirm,
    ),
  );
  if (choice !== confirm) return;
  const failed = yield* removeBuildDirectories(directories);
  if (failed.length > 0) {
    void vscode.window.showErrorMessage(
      `Could not delete ${failed.length} of ${directories.length} build/ ${noun}: ${failed.join(', ')}. See the TeXRA log for the cause.`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `Deleted ${directories.length} build/ ${noun}.`,
  );
});
