import { logMissingOutputs, type AgentTrace } from '@agent/trace';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  type FileLocation,
  type OutputFileInfo,
  type OutputXmlSummary,
  type StorageKey,
} from '@shared/schemas';
import { flexibleFS, replaceInputCommands } from '@utils/files';
import {
  extractMultipleTextFromTag,
  extractTextFromTag,
} from '@utils/text/xmlUtils';

import { indentLatexFiles } from './LatexOutputUtils';
import { tryOperation } from './outputOperations';
import type { XmlOutputManager } from './XmlOutputManager';

export interface ProcessingContext {
  agentSetting: AgentWorkflowSetting;
  baseFiles: FileLocation[];
  streamId: string;
  runtimeHost: AgentRuntimeHost;
  logger: AgentTrace;
  xmlManager: XmlOutputManager;
  setRoundOutputs: (round: number, outputs: OutputFileInfo[]) => void;
  ensureRoundData: (round: number) => { xmlSummary: OutputXmlSummary };
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
            this.ctx.agentSetting.documentTag,
            currRound,
          );

        if (processedPairs.length > 0) {
          const locations = processedPairs.map(
            (p: OutputFileInfo) => p.location,
          );
          await indentLatexFiles(locations, logger);
          logger.debug(
            `Indented multiple output files: ${locations.map((l) => l.absolutePath).join(',')}`,
          );

          if (this.ctx.baseFiles.length > 0) {
            await replaceInputCommands(this.ctx.baseFiles, locations, logger);
          }
          this.ctx.setRoundOutputs(currRound, processedPairs);
          await this.captureXmlSummary(currRound, rawLocation, processedPairs);
          return;
        }

        logger.debug(
          `No processed files were generated from ${outputLocation.absolutePath}`,
        );
        this.emitMissingOutputs(currRound, outputLocation);
        await this.handleEmptyOutput(currRound, rawLocation);
      },
      {
        logger,
        level: 'debug',
        label: 'Error processing output file',
        recover: async () => {
          this.emitMissingOutputs(currRound, outputLocation);
          await this.handleEmptyOutput(currRound, rawLocation);
        },
      },
    );
  }

  /** Logs and signals the UI that a round produced no extractable output files. */
  private emitMissingOutputs(
    currRound: number,
    outputLocation: FileLocation,
  ): void {
    logMissingOutputs(this.ctx.logger, {
      missing: [] as string[],
      xmlFile: outputLocation.absolutePath,
      documentTag: this.ctx.agentSetting.documentTag,
    });
    this.ctx.runtimeHost.emit('updateMissingOutputs', {
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
        const rawContent = await flexibleFS.read(rawOutput);
        const tagContents: Record<string, string | string[]> = {};
        const documents: string[] = [];
        const documentTag = this.ctx.agentSetting.documentTag;

        const documentEntries = extractMultipleTextFromTag(
          rawContent,
          documentTag,
        );
        if (documentEntries.length > 0) {
          const trimmedDocuments = documentEntries.map((e) => e.content.trim());
          if (trimmedDocuments.length === 1) {
            tagContents[documentTag] = trimmedDocuments[0];
          } else {
            tagContents[documentTag] = trimmedDocuments;
          }

          for (const entry of documentEntries) {
            const nameAttr = entry.name ? ` name="${entry.name}"` : '';
            documents.push(
              `<${documentTag}${nameAttr}>${entry.content.trim()}</${documentTag}>`,
            );
          }
        } else {
          const singleDocument = extractTextFromTag(
            rawContent,
            documentTag,
          ).trim();
          if (singleDocument) {
            tagContents[documentTag] = singleDocument;
            documents.push(
              `<${documentTag}>${singleDocument}</${documentTag}>`,
            );
          }
        }

        const scratchpadContent = extractTextFromTag(
          rawContent,
          'scratchpad',
        ).trim();
        if (scratchpadContent) {
          tagContents.scratchpad = scratchpadContent;
        }

        data.xmlSummary = {
          tagContents,
          documents,
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
