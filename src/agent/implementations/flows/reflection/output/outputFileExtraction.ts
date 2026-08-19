/**
 * Output file extraction orchestration.
 *
 * Drives the agent output pipeline: waits for workspace preparation, then
 * unpacks <documents><document name="..."> containers from the model's XML
 * response.
 *
 * Note: this module is about the *agent output pipeline*, not general XML
 * parsing. Low-level XML text utilities live in @utils/text/xmlExtraction.
 */

import { reportMissingOutputs } from '@agent/runtime/runFactEvents';
import {
  fileLocationDisplayPath,
  MESSAGE_TYPES,
  OUTPUT_DOCUMENTS_TAG,
  type FileLocation,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';

import { replaceInputCommands } from './fileMapping';
import { tryOperation } from './outputOperations';
import {
  ensureRoundData,
  withOutputStage,
  type OutputState,
  type OutputDependencies,
} from './outputState';
import type { XmlOutputManager } from './XmlOutputManager';

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

/**
 * Base files for the unlabeled-fence similarity fallback. Rounds after the
 * first revise the previous round's outputs, so compare against those, not
 * the originals the content may have diverged from. Positional order is
 * preserved (the fallback zips base files with the agent's inputFiles by
 * index); a file the previous round did not produce keeps its original
 * location.
 */
function similarityBaseFiles(
  state: OutputState,
  deps: OutputDependencies,
  currRound: number,
): FileLocation[] {
  const { baseFiles } = deps;
  if (currRound === 0) return baseFiles;
  const previousOutputs = ensureRoundData(state, currRound - 1).outputs;
  if (previousOutputs.length === 0) return baseFiles;

  // An output's source is the workspace-relative document name; a base
  // file is workspace-relative too, except external locations, which only
  // carry an absolute path — hence the suffix comparison. A suffix match
  // only counts when it is unambiguous: a basename-only source (e.g. from
  // a `% main.tex` header) must not map onto several same-named base
  // files in different directories.
  const pathOf = (location: FileLocation): string =>
    normalizeFilePath(fileLocationDisplayPath(location));
  const basesMatching = (source: string): number =>
    baseFiles.filter((base) => {
      const path = pathOf(base);
      return path === source || path.endsWith(`/${source}`);
    }).length;

  return baseFiles.map((location) => {
    const path = pathOf(location);
    const previous = previousOutputs.find((output) => {
      const source = normalizeFilePath(output.source);
      if (source === path) return true;
      return path.endsWith(`/${source}`) && basesMatching(source) === 1;
    });
    return previous?.location ?? location;
  });
}

/**
 * Signal a missing/empty round to the UI, then persist the empty round summary.
 */
async function handleNoOutputs(
  state: OutputState,
  deps: OutputDependencies,
  currRound: number,
  outputLocation: FileLocation,
): Promise<void> {
  // Distinguish a genuinely empty turn from a non-empty response that simply
  // could not be parsed: if the model returned content but nothing extracted,
  // it almost always means it did not wrap each file in
  // `<document name="…">`. Surface that as a warning so the round is not a
  // silent "success" that writes no files; the raw response is kept for recovery.
  const rawText = await AbsoluteFS.read(outputLocation.absolutePath).catch(
    () => '',
  );
  if (rawText.trim().length > 0) {
    deps.logger.warn(
      `The model returned output but no files could be extracted from it: it likely did not wrap each document in <${OUTPUT_DOCUMENTS_TAG}>. The raw response was kept at ${outputLocation.absolutePath} for recovery.`,
      {
        data: {
          round: currRound,
          rawResponsePath: outputLocation.absolutePath,
        },
      },
    );
  }
  reportMissingOutputs(deps.logger, {
    streamId: deps.runScope.streamId,
    round: currRound,
    missing: [],
    xmlFile: outputLocation.absolutePath,
  });

  ensureRoundData(state, currRound).outputs = [];
}

/** Unpacks the round's <documents> container into per-document output files. */
export async function processMultipleOutputs(
  state: OutputState,
  deps: OutputDependencies,
  xmlManager: XmlOutputManager,
  outputLocation: FileLocation,
  currRound: number,
): Promise<void> {
  const { logger } = deps;

  logger.debug(
    `Processing multiple outputs for ${outputLocation.absolutePath}`,
  );

  await tryOperation(
    async () => {
      const processedPairs = await xmlManager.splitScratchpadMultipleOutputXml(
        outputLocation,
        currRound,
        'scratchpad',
        similarityBaseFiles(state, deps, currRound),
      );

      if (processedPairs.length === 0) {
        logger.debug(
          `No processed files were generated from ${outputLocation.absolutePath}`,
        );
        await handleNoOutputs(state, deps, currRound, outputLocation);
        return;
      }

      const locations = processedPairs.map((p) => p.location);
      if (deps.baseFiles.length > 0) {
        await replaceInputCommands(deps.baseFiles, locations, logger);
      }
      ensureRoundData(state, currRound).outputs = processedPairs;
    },
    {
      logger,
      level: 'debug',
      label: 'Error processing output file',
      recover: () => handleNoOutputs(state, deps, currRound, outputLocation),
    },
  );
}

/** Extracts files from XML output for a round. */
export async function extractFilesFromXml(
  state: OutputState,
  deps: OutputDependencies,
  xmlManager: XmlOutputManager,
  outputLocation: FileLocation,
  currRound: number,
): Promise<void> {
  await withOutputStage(
    deps,
    `Process files r${currRound}`,
    undefined,
    async () => {
      await prepareRunWorkspaceIfNeeded(state, deps);

      const data = ensureRoundData(state, currRound);
      data.rawOutput ??= outputLocation;

      // The unified protocol emits <documents><document name="..."> containers
      // (N >= 1), so all agents route through the multi-document path.
      await processMultipleOutputs(
        state,
        deps,
        xmlManager,
        outputLocation,
        currRound,
      );
    },
  );
}
