/**
 * XML file extraction for output processing.
 *
 * Extracts output files from XML responses.
 * Agents using the unified protocol (documentTag === 'documents') always produce
 * <documents><document name="..."> containers and are extracted via the
 * multi-document path regardless of output file count.
 * Legacy agents with a custom documentTag use single-document extraction.
 */

import type { StageHandle } from '@agent/trace';
import { toErrorMessage } from '@common/errors';
import {
  MESSAGE_TYPES,
  type FileLocation,
  type StorageKey,
} from '@shared/schemas';
import { AbsoluteFS } from '@utils/files';

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

const NAMED_DOCUMENT_TAG_PATTERN = /<document\b[^>]*\bname\s*=/;

async function shouldUseMultiDocumentPath(
  outputLocation: FileLocation,
  documentTag: string,
  deps: OutputDependencies,
): Promise<boolean> {
  if (documentTag === 'documents') return true;

  // Legacy agents that explicitly set a custom documentTag are deprecated.
  // New agents should use documentTag: documents (the default). The single-document
  // extraction path will be removed in a future release.
  deps.logger.warn(
    `Agent uses deprecated documentTag "${documentTag}". ` +
      `Update the agent YAML to use documentTag: documents. ` +
      `Single-document extraction will be removed in a future release.`,
  );

  try {
    const outputContent = await AbsoluteFS.read(outputLocation.absolutePath);
    return NAMED_DOCUMENT_TAG_PATTERN.test(outputContent);
  } catch (error) {
    deps.logger.debug(
      `Unable to inspect XML output shape: ${toErrorMessage(error)}`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
    return false;
  }
}

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
        agentSetting: deps.setting,
        baseFiles: deps.baseFiles,
        streamId: deps.streamId,
        runtimeHost: deps.runtimeHost,
        logger: deps.logger,
        xmlManager,
        setRoundOutputs: (round: number, outputs) => {
          const roundData = ensureRoundData(state, round);
          roundData.outputs = outputs;
        },
        ensureRoundData: (round: number) => ensureRoundData(state, round),
      };

      const fileProcessor = new OutputFileProcessor(processingContext);

      // Unified protocol emits <documents><document name="..."> containers
      // (N >= 1). Legacy plural wrappers can also contain named <document>
      // children, so route by the actual payload shape instead of the wrapper
      // tag alone.
      const useMultiDocumentPath = await shouldUseMultiDocumentPath(
        outputLocation,
        deps.setting.documentTag,
        deps,
      );

      if (useMultiDocumentPath) {
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
      );
    },
  );
}
