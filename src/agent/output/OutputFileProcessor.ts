import { logMissingOutputs, type AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import { replaceInputCommands } from '@agent/output/fileMapping';
import {
  type FileLocation,
  type OutputFileInfo,
  type RoundOutput,
} from '@shared/schemas';
import { OUTPUT_DOCUMENTS_TAG } from '@shared/schemas/output';
import { normalizeFilePath } from '@utils/core';
import { FlexibleFS } from '@utils/files';
import {
  extractMultipleTextFromTag,
  extractTextFromTag,
} from '@utils/text/xmlUtils';

import { tryOperation } from './outputOperations';
import type { XmlOutputManager } from './XmlOutputManager';

export interface ProcessingContext {
  baseFiles: FileLocation[];
  streamId: string;
  runtimeHost: AgentRuntimeHost;
  logger: AgentTrace;
  xmlManager: XmlOutputManager;
  setRoundOutputs: (round: number, outputs: OutputFileInfo[]) => void;
  ensureRoundData: (round: number) => RoundOutput;
}

/** Handles processing of single and multiple output files. */
export class OutputFileProcessor {
  constructor(private readonly ctx: ProcessingContext) {}

  async processMultipleOutputs(
    outputLocation: FileLocation,
    currRound: number,
    rawLocation: FileLocation,
  ): Promise<void> {
    const { logger } = this.ctx;

    logger.debug(
      `Processing multiple outputs for ${outputLocation.absolutePath}`,
    );

    await tryOperation(
      async () => {
        const processedPairs =
          await this.ctx.xmlManager.splitScratchpadMultipleOutputXml(
            outputLocation,
            currRound,
            'scratchpad',
            this.similarityBaseFiles(currRound),
          );

        if (processedPairs.length === 0) {
          logger.debug(
            `No processed files were generated from ${outputLocation.absolutePath}`,
          );
          await this.handleNoOutputs(currRound, outputLocation, rawLocation);
          return;
        }

        const locations = processedPairs.map((p) => p.location);
        if (this.ctx.baseFiles.length > 0) {
          await replaceInputCommands(this.ctx.baseFiles, locations, logger);
        }
        this.ctx.setRoundOutputs(currRound, processedPairs);
        await this.captureXmlSummary(currRound, rawLocation, processedPairs);
      },
      {
        logger,
        level: 'debug',
        label: 'Error processing output file',
        recover: () =>
          this.handleNoOutputs(currRound, outputLocation, rawLocation),
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
    const { baseFiles } = this.ctx;
    if (currRound === 0) return baseFiles;
    const previousOutputs = this.ctx.ensureRoundData(currRound - 1).outputs;
    if (previousOutputs.length === 0) return baseFiles;

    // An output's source is the workspace-relative document name; a base
    // file is workspace-relative too, except external locations, which only
    // carry an absolute path — hence the suffix comparison. A suffix match
    // only counts when it is unambiguous: a basename-only source (e.g. from
    // a `% main.tex` header) must not map onto several same-named base
    // files in different directories.
    const pathOf = (location: FileLocation): string =>
      normalizeFilePath(
        location.kind === 'external'
          ? location.absolutePath
          : location.relativePath,
      );
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
    rawLocation: FileLocation,
  ): Promise<void> {
    await this.emitMissingOutputs(currRound, outputLocation);
    await this.handleEmptyOutput(currRound, rawLocation);
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
    const rawText = await FlexibleFS.read(outputLocation).catch(() => '');
    if (rawText.trim().length > 0) {
      this.ctx.logger.warn(
        `The model returned output but no files could be extracted from it — it likely did not wrap each document in <${OUTPUT_DOCUMENTS_TAG}>. The raw response was kept at ${outputLocation.absolutePath} for recovery.`,
        {
          data: {
            round: currRound,
            rawResponsePath: outputLocation.absolutePath,
          },
        },
      );
    }
    logMissingOutputs(this.ctx.logger, {
      missing: [] as string[],
      xmlFile: outputLocation.absolutePath,
    });
    emitRunFact(this.ctx.logger, 'updateMissingOutputs', {
      streamId: this.ctx.streamId,
      filesByRound: { [currRound]: [] },
    });
  }

  private handleEmptyOutput(
    round: number,
    rawLocation: FileLocation,
  ): Promise<void> {
    this.ctx.setRoundOutputs(round, []);
    return this.captureXmlSummary(round, rawLocation, []);
  }

  private async captureXmlSummary(
    round: number,
    rawOutput: FileLocation | null,
    processed: OutputFileInfo[],
  ): Promise<void> {
    const data = this.ctx.ensureRoundData(round);
    const singleFile =
      processed.length === 1 ? processed[0].location.absolutePath : null;

    const emptySummary = {
      tagContents: {},
      documents: [] as string[],
      singleOutputFile: singleFile,
      sourceLocation: rawOutput,
    };

    if (!rawOutput?.absolutePath) {
      data.xmlSummary = emptySummary;
      return;
    }

    await tryOperation(
      async () => {
        const rawContent = await FlexibleFS.read(rawOutput);
        const tagContents: Record<string, string[]> = {};

        const documentEntries = extractMultipleTextFromTag(
          rawContent,
          OUTPUT_DOCUMENTS_TAG,
        );
        if (documentEntries.length > 0) {
          tagContents[OUTPUT_DOCUMENTS_TAG] = documentEntries.map((e) =>
            e.content.trim(),
          );
        } else {
          const singleDocument = extractTextFromTag(
            rawContent,
            OUTPUT_DOCUMENTS_TAG,
          ).trim();
          if (singleDocument) {
            tagContents[OUTPUT_DOCUMENTS_TAG] = [singleDocument];
          }
        }

        const scratchpadContent = extractTextFromTag(
          rawContent,
          'scratchpad',
        ).trim();
        if (scratchpadContent) {
          tagContents.scratchpad = [scratchpadContent];
        }

        // `documents` used to hold the same text again, re-wrapped in its
        // XML tags — pure duplication of `tagContents[OUTPUT_DOCUMENTS_TAG]`
        // with nothing reading either the tag-wrapped or bare form
        // downstream. Every full-text round summary was cloned per node
        // step (see persistedFlow.ts), so the duplicate copy cost grew with
        // every round of every run.
        data.xmlSummary = {
          tagContents,
          documents: [],
          singleOutputFile: singleFile,
          sourceLocation: rawOutput,
        };
      },
      {
        logger: this.ctx.logger,
        level: 'debug',
        label: `Failed to collect XML summary for round ${round}`,
        recover: () => {
          data.xmlSummary = { ...emptySummary };
        },
      },
    );
  }
}
