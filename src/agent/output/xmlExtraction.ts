/**
 * XML file extraction for output processing.
 *
 * Extracts output files from XML responses, handling both single
 * and multiple output scenarios.
 */

import {
  MESSAGE_TYPES,
  type FileLocation,
  type StorageKey,
} from '@shared/schemas';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import type { AgentLogStage } from '@logger/AgentLogger';

import {
  OutputFileProcessor,
  type ProcessingContext,
} from './OutputFileProcessor';
import {
  ensureRoundData,
  getStorageKey,
  withOutputStage,
  type OutputState,
  type OutputDependencies,
} from './outputState';
import type { XmlOutputManager } from './XmlOutputManager';

// ============================================================================
// Helpers
// ============================================================================

/** Waits for run workspace preparation to complete. */
// This function is very strange?... need to consider if in the future there are cleaner ways to do this.
async function prepareRunWorkspaceIfNeeded(
  state: OutputState,
  deps: OutputDependencies,
): Promise<void> {
  if (!state.runPreparation) return;

  try {
    await state.runPreparation;
  } catch (error) {
    deps.logger.debug(
      `Failed to prepare run workspace: ${toErrorMessage(error)}`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
  } finally {
    state.runPreparation = null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Extracts files from XML output for a round. */
export async function extractFilesFromXml(
  state: OutputState,
  deps: OutputDependencies,
  xmlManager: XmlOutputManager,
  outputLocation: FileLocation,
  currRound: number,
  stage?: AgentLogStage,
): Promise<void> {
  await withOutputStage(
    deps,
    `Process files r${currRound}`,
    stage,
    async () => {
      await prepareRunWorkspaceIfNeeded(state, deps);

      const data = ensureRoundData(state, currRound);
      data.rawOutput ??= outputLocation;
      const rawLocation = data.rawOutput;

      const processingContext: ProcessingContext = {
        agentSetting: deps.agentSetting,
        baseFiles: deps.baseFiles,
        streamId: deps.streamId,
        logger: deps.logger,
        xmlManager,
        setRoundOutputs: (round: number, outputs) => {
          const roundData = ensureRoundData(state, round);
          roundData.outputs = outputs;
        },
        ensureRoundData: (round: number) => ensureRoundData(state, round),
      };

      const fileProcessor = new OutputFileProcessor(processingContext);
      const storageKey: StorageKey = getStorageKey(state);

      const hasMultipleOutputs =
        deps.agentConfig.useMultipleOutputs &&
        deps.agentConfig.outputFiles?.length > 0;

      if (hasMultipleOutputs) {
        await fileProcessor.processMultipleOutputs(
          outputLocation,
          currRound,
          rawLocation,
        );
        return;
      }

      await fileProcessor.processSingleOutput(
        outputLocation,
        currRound,
        rawLocation,
        storageKey,
      );
    },
  );
}
