/**
 * Output validation for expected files.
 *
 * Validates that expected output files exist after agent processing,
 * reporting missing files for user notification.
 */

import { Effect, FileSystem } from 'effect';

import { debugInternal } from '@agent/trace';
import { workflowOutputRoundDir } from '@shared/constants/workflowOutput';
import type { FileLocation } from '@shared/schemas';

import {
  ensureRoundData,
  reportMissingOutputs,
  type OutputDependencies,
  type OutputState,
} from './outputState';

/** Checks that expected output files exist. */
export const checkExpectedOutputs = Effect.fn(
  'reflection.checkExpectedOutputs',
)(function* (
  state: OutputState,
  deps: OutputDependencies,
  outputLocation: FileLocation,
  currRound: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const expected = deps.config.outputFiles;
  let missing: string[] = [];

  if (expected?.length) {
    const results = yield* Effect.forEach(
      expected,
      (file) =>
        fs
          // The round writes its outputs into its own directory; the
          // run-root entry of the same name is the workspace file, which
          // exists only once an output has been delivered there.
          .exists(
            deps.fileService.createLocation(
              `${workflowOutputRoundDir(currRound)}/${file}`,
            ).absolutePath,
          )
          .pipe(Effect.map((exists) => ({ file, exists }))),
      { concurrency: 'unbounded' },
    );
    missing = results.filter((r) => !r.exists).map((r) => r.file);

    if (missing.length > 0) {
      const xmlExists = yield* fs.exists(outputLocation.absolutePath);
      reportMissingOutputs(state, deps.logger, {
        round: currRound,
        missing,
        xmlFile: xmlExists ? outputLocation.absolutePath : null,
      });
      deps.logger.debug(`Missing expected outputs for round ${currRound}`, {
        data: missing,
      });
    } else {
      deps.logger.debug(`All expected outputs exist after round ${currRound}`);
    }
  } else {
    debugInternal(deps.logger, `No expected outputs for round ${currRound}`);
  }

  // Clear an earlier missing report if this round is reprocessed and all
  // expected outputs are now present. Empty means none are known missing.
  if (missing.length === 0) {
    ensureRoundData(state, currRound).missingOutputs = [];
  }

  return { missing };
});
