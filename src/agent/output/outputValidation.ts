/**
 * Output validation for expected files.
 *
 * Validates that expected output files exist after agent processing,
 * reporting missing files for user notification.
 */

import { debugInternal, type StageHandle } from '@agent/trace';
import {
  emitRunFact,
  reportMissingOutputs,
} from '@agent/runtime/runFactEvents';
import type { FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';

import {
  getStorageKey,
  withOutputStage,
  type OutputState,
  type OutputDependencies,
} from './outputState';

// ============================================================================
// Public API
// ============================================================================

/** Checks that expected output files exist. */
export async function checkExpectedOutputs(
  state: OutputState,
  deps: OutputDependencies,
  outputLocation: FileLocation,
  currRound: number,
  stage?: StageHandle,
): Promise<{ missing: string[] }> {
  return withOutputStage(
    deps,
    `Validate expected r${currRound}`,
    stage,
    async (): Promise<{ missing: string[] }> => {
      const storageKey = getStorageKey(state);
      const expected = deps.config.outputFiles;
      if (!expected?.length) {
        debugInternal(
          deps.logger,
          `No expected outputs for round ${currRound} storageKey=${storageKey}`,
        );
        emitRunFact(deps.logger, 'updateMissingOutputs', {
          streamId: deps.streamId,
          filesByRound: { [currRound]: [] },
        });
        return { missing: [] };
      }

      const results = await Promise.all(
        expected.map(async (file) => ({
          file,
          exists: await AbsoluteFS.exists(
            deps.fileService.createLocation(file).absolutePath,
          ),
        })),
      );
      const missing = results.filter((r) => !r.exists).map((r) => r.file);
      const xmlExists = await AbsoluteFS.exists(outputLocation.absolutePath);

      if (missing.length > 0) {
        reportMissingOutputs(deps.logger, {
          streamId: deps.streamId,
          round: currRound,
          missing,
          xmlFile: xmlExists ? outputLocation.absolutePath : null,
        });
        deps.logger.debug(`Missing expected outputs for round ${currRound}`, {
          data: missing,
        });
      } else {
        emitRunFact(deps.logger, 'updateMissingOutputs', {
          streamId: deps.streamId,
          filesByRound: { [currRound]: [] },
        });
        deps.logger.debug(
          `All expected outputs exist after round ${currRound}`,
        );
      }

      return { missing };
    },
  );
}
