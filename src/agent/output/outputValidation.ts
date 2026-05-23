/**
 * Output validation for expected files.
 *
 * Validates that expected output files exist after agent processing,
 * reporting missing files for user notification.
 */

import type { StageHandle } from '@agent/trace';
import {
  MESSAGE_TYPES,
  type FileLocation,
  type StorageKey,
} from '@shared/schemas';
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
        deps.logger.debug(
          `No expected outputs for round ${currRound} storageKey=${storageKey}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
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
        deps.logger.missingOutputs({
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
