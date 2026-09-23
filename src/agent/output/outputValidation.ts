/**
 * Output validation for expected files.
 *
 * Validates that expected output files exist after agent processing,
 * reporting missing files for user notification.
 */

import { Effect, FileSystem } from 'effect';

import { debugInternal } from '@agent/trace';
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
          .exists(deps.fileService.createLocation(file).absolutePath)
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

  // A round with nothing missing reports an empty set so consumers can
  // distinguish "checked, all present" from "never reported".
  if (missing.length === 0) {
    ensureRoundData(state, currRound).missingOutputs = [];
  }

  return { missing };
});
