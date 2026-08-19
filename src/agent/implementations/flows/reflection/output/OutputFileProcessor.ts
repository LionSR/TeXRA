import { reportMissingOutputs } from '@agent/runtime/runFactEvents';
import {
  fileLocationDisplayPath,
  OUTPUT_DOCUMENTS_TAG,
  type FileLocation,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { replaceInputCommands } from './fileMapping';

import { tryOperation } from './outputOperations';
import {
  ensureRoundData,
  type OutputDependencies,
  type OutputState,
} from './outputState';
import type { XmlOutputManager } from './XmlOutputManager';

/** Handles processing of single and multiple output files. */
export class OutputFileProcessor {
  constructor(
    private readonly state: OutputState,
    private readonly deps: OutputDependencies,
    private readonly xmlManager: XmlOutputManager,
  ) {}

  async processMultipleOutputs(
    outputLocation: FileLocation,
    currRound: number,
  ): Promise<void> {
    const { logger } = this.deps;

    logger.debug(
      `Processing multiple outputs for ${outputLocation.absolutePath}`,
    );

    await tryOperation(
      async () => {
        const processedPairs =
          await this.xmlManager.splitScratchpadMultipleOutputXml(
            outputLocation,
            currRound,
            'scratchpad',
            this.similarityBaseFiles(currRound),
          );

        if (processedPairs.length === 0) {
          logger.debug(
            `No processed files were generated from ${outputLocation.absolutePath}`,
          );
          await this.handleNoOutputs(currRound, outputLocation);
          return;
        }

        const locations = processedPairs.map((p) => p.location);
        if (this.deps.baseFiles.length > 0) {
          await replaceInputCommands(this.deps.baseFiles, locations, logger);
        }
        ensureRoundData(this.state, currRound).outputs = processedPairs;
      },
      {
        logger,
        level: 'debug',
        label: 'Error processing output file',
        recover: () => this.handleNoOutputs(currRound, outputLocation),
      },
    );
  }

  /**
   * Base files for the unlabeled-fence similarity fallback. Rounds after the
   * first revise the previous round's outputs, so compare against those, not
   * the originals the content may have diverged from. Positional order is
   * preserved (the fallback zips base files with the agent's inputFiles by
   * index); a file the previous round did not produce keeps its original
   * location.
   */
  private similarityBaseFiles(currRound: number): FileLocation[] {
    const { baseFiles } = this.deps;
    if (currRound === 0) return baseFiles;
    const previousOutputs = ensureRoundData(this.state, currRound - 1).outputs;
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

  /** Signal a missing/empty round, then persist the empty round summary. */
  private async handleNoOutputs(
    currRound: number,
    outputLocation: FileLocation,
  ): Promise<void> {
    await this.emitMissingOutputs(currRound, outputLocation);
    ensureRoundData(this.state, currRound).outputs = [];
  }

  /** Logs and signals the UI that a round produced no extractable output files. */
  private async emitMissingOutputs(
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
      this.deps.logger.warn(
        `The model returned output but no files could be extracted from it: it likely did not wrap each document in <${OUTPUT_DOCUMENTS_TAG}>. The raw response was kept at ${outputLocation.absolutePath} for recovery.`,
        {
          data: {
            round: currRound,
            rawResponsePath: outputLocation.absolutePath,
          },
        },
      );
    }
    reportMissingOutputs(this.deps.logger, {
      streamId: this.deps.runScope.streamId,
      round: currRound,
      missing: [],
      xmlFile: outputLocation.absolutePath,
    });
  }
}
