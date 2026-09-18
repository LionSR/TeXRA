// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runCleanRunDir } from '@housekeeping/runDirOps';
import { createLog } from '@logger/logUtils';

import type { FileOpResult } from '@shared/schemas';
import { type CleanConfig } from './fileOpSchemas';

const CHANNEL = 'cleanCommands';
const log = createLog(CHANNEL);

const showCleanResult = (
  result: FileOpResult,
  inputFile: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (result.status) {
      case 'success':
        vscode.window.showInformationMessage(
          `Cleanup complete for ${inputFile}`,
        );
        break;
      case 'noFiles':
        vscode.window.showInformationMessage(
          `No files found to clean for ${inputFile}`,
        );
        break;
      case 'missingParams':
        yield* Effect.forkDetach(
          showLoggedMessage(CHANNEL, 'Select an input file before cleaning.'),
        );
        break;
      case 'error':
        void vscode.window.showErrorMessage(
          `Error during cleanup: ${result.error}`,
        );
        break;
    }
  });

/** Clean removes a run's own storage; without a run there is nothing to clean. */
export const handleClean = Effect.fn('cleanCommands.handleClean')(function* (
  config: CleanConfig,
) {
  log.debug(`Clean command called with config: ${JSON.stringify(config)}`);
  const result: FileOpResult = config.runId
    ? yield* runCleanRunDir(config.runId)
    : { status: 'noFiles' };
  yield* showCleanResult(result, config.inputFile);
});
