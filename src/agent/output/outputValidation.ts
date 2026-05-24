/**
 * Output validation for expected files.
 *
 * Validates that expected output files exist after agent processing,
 * reporting missing files for user notification.
 */

import {
  debugInternal,
  logMissingOutputs,
  type StageHandle,
} from '@agent/trace';
import type { FileLocation, StorageKey } from '@shared/schemas';
import { flexibleFS } from '@utils/files';

import {
  getStorageKey,
  withOutputStage,
  type OutputState,
  type OutputDependencies,
} from './outputState';

// ============================================================================
// Types
// ============================================================================

/** Result of output validation. */
export interface ValidationResult {
  storageKey: StorageKey;
  currRound: number;
  missing: string[];
  xmlExists: boolean;
}

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
): Promise<ValidationResult> {
  return withOutputStage(
    deps,
    `Validate expected r${currRound}`,
    stage,
    async (): Promise<ValidationResult> => {
      const storageKey = getStorageKey(state);
      const expected = deps.config.outputFiles;
      if (!expected?.length) {
        debugInternal(
          deps.logger,
          `No expected outputs for round ${currRound} storageKey=${storageKey}`,
        );
        return { storageKey, currRound, missing: [], xmlExists: false };
      }

      const checks = expected.map(async (file) => ({
        file,
        exists: await flexibleFS.exists(deps.fileService.createLocation(file)),
      }));
      const results = await Promise.all(checks);
      const missing = results.filter((r) => !r.exists).map((r) => r.file);
      const xmlExists = await flexibleFS.exists(outputLocation);

      if (missing.length > 0) {
        logMissingOutputs(deps.logger, {
          missing,
          xmlFile: xmlExists ? outputLocation.absolutePath : null,
          documentTag: deps.setting.documentTag,
        });
        deps.logger.debug(
          `Missing expected outputs for round ${currRound}: ${missing.join(', ')}`,
        );
      } else {
        deps.logger.debug(
          `All expected outputs exist after round ${currRound}`,
        );
      }

      return { storageKey, currRound, missing, xmlExists };
    },
  );
}
