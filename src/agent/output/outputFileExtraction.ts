/**
 * Output file extraction orchestration.
 *
 * Drives the agent output pipeline: waits for workspace preparation, builds
 * a ProcessingContext, then dispatches to OutputFileProcessor to unpack
 * <documents><document name="..."> containers from the model's XML response.
 *
 * Note: this module is about the *agent output pipeline*, not general XML
 * parsing. Low-level XML text utilities live in @utils/text/xmlExtraction.
 */

import type { StageHandle } from '@agent/trace';
import { MESSAGE_TYPES, type FileLocation } from '@shared/schemas';

import {
  OutputFileProcessor,
  type ProcessingContext,
} from './OutputFileProcessor';
import {
  ensureRoundData,
  withOutputStage,
  type OutputState,
  type OutputDependencies,
} from './outputState';
import type { XmlOutputManager } from './XmlOutputManager';

// ============================================================================
// Helpers
// ============================================================================

/** Waits for run workspace preparation to complete, clearing the promise once settled. */
async function prepareRunWorkspaceIfNeeded(
  state: OutputState,
  deps: OutputDependencies,
): Promise<void> {
  if (!state.runPreparation) return;

  try {
    await state.runPreparation;
  } catch (error) {
    deps.logger.debug('Failed to prepare run workspace', {
      data: error,
      messageType: MESSAGE_TYPES.INTERNAL,
    });
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
  stage?: StageHandle,
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

      // The unified protocol emits <documents><document name="..."> containers
      // (N >= 1), so all agents route through the multi-document path.
      await fileProcessor.processMultipleOutputs(
        outputLocation,
        currRound,
        rawLocation,
      );
    },
  );
}
