import * as path from 'path';

import {
  MESSAGE_TYPES,
  type FileLocation,
  type OutputFileInfo,
  type OutputXmlSummary,
  type StorageKey,
} from '@shared/schemas';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import type { AgentLogger } from '@logger/AgentLogger';
import { flexibleFS, replaceInputCommands } from '@utils/files';
import {
  extractMultipleTextFromTag,
  extractTextFromTag,
} from '@utils/text/xmlUtils';
import { bus } from '@eventBus/ProgressEventBus';

import {
  cleanupLatexBackups,
  indentLatexFile,
  indentLatexFiles,
} from './LatexOutputUtils';
import type { XmlOutputManager } from './XmlOutputManager';

const SCRATCHPAD_TAG_PATTERN = /<scratchpad\s*>/i;

export interface ProcessingContext {
  agentSetting: AgentWorkflowSetting;
  baseFiles: FileLocation[];
  streamId: string;
  logger: AgentLogger;
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

    try {
      const processedPairs =
        await this.ctx.xmlManager.splitScratchpadMultipleOutputXml(
          outputLocation,
          this.ctx.agentSetting.documentTag,
          currRound,
        );

      if (processedPairs.length > 0) {
        const locations = processedPairs.map((p: OutputFileInfo) => p.location);
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
      await this.handleEmptyOutput(currRound, rawLocation);
    } catch (err) {
      logger.debug(`Error processing output file: ${toErrorMessage(err)}`, {
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      await this.handleEmptyOutput(currRound, rawLocation);
    }
  }

  private async handleEmptyOutput(
    round: number,
    rawLocation: FileLocation,
  ): Promise<void> {
    this.ctx.setRoundOutputs(round, []);
    await cleanupLatexBackups(rawLocation, this.ctx.logger);
    await this.captureXmlSummary(round, rawLocation, []);
  }

  async processSingleOutput(
    outputLocation: FileLocation,
    currRound: number,
    rawLocation: FileLocation,
    storageKey: StorageKey,
  ): Promise<void> {
    const { agentSetting, logger } = this.ctx;

    logger.debug(`Processing single output for ${outputLocation.absolutePath}`);

    try {
      const shouldProcessXml = this.shouldProcessXml(agentSetting);
      const processed = shouldProcessXml
        ? await this.ctx.xmlManager.processSingleXmlOutput(
            outputLocation,
            currRound,
          )
        : {
            source: path.basename(outputLocation.absolutePath),
            round: currRound,
            location: rawLocation ?? outputLocation,
            lineage: null,
            diff: null,
          };

      if (!processed.location.absolutePath) {
        logger.debug(
          `No processed file was generated from ${outputLocation.absolutePath}`,
        );
        this.ctx.setRoundOutputs(currRound, []);
        await this.captureXmlSummary(currRound, rawLocation, []);
        return;
      }

      await indentLatexFile(processed.location, logger);
      logger.debug(
        `Indented single output file: ${processed.location.absolutePath}`,
      );

      if (this.ctx.baseFiles.length > 0) {
        await replaceInputCommands(
          this.ctx.baseFiles,
          [processed.location],
          logger,
        );
      }

      this.ctx.setRoundOutputs(currRound, [processed]);
      await this.captureXmlSummary(currRound, rawLocation, [processed]);
    } catch (err) {
      logger.debug(`Error processing output file: ${toErrorMessage(err)}`, {
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      const missingOutputsData = {
        missing: [] as string[],
        xmlFile: outputLocation.absolutePath,
        documentTag: agentSetting.documentTag,
      };
      logger.missingOutputs(missingOutputsData);
      bus.emit('updateMissingOutputs', {
        streamId: this.ctx.streamId,
        storageKey,
        filesByRound: { [currRound]: [] },
      });
      this.ctx.setRoundOutputs(currRound, []);
      await this.captureXmlSummary(currRound, rawLocation, []);
    }
  }

  private async captureXmlSummary(
    round: number,
    rawOutput: FileLocation | null,
    processed: OutputFileInfo[],
  ): Promise<void> {
    const data = this.ctx.ensureRoundData(round);
    const singleFile =
      processed.length === 1 ? processed[0].location.absolutePath : null;

    const createEmptySummary = () => ({
      tagContents: {},
      documents: [] as string[],
      singleOutputFile: singleFile,
      sourceLocation: rawOutput,
    });

    if (!rawOutput?.absolutePath) {
      data.xmlSummary = createEmptySummary();
      return;
    }

    try {
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
          documents.push(`<${documentTag}>${singleDocument}</${documentTag}>`);
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
    } catch (error) {
      this.ctx.logger.debug(
        `Failed to collect XML summary for round ${round}: ${toErrorMessage(error)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
      data.xmlSummary = createEmptySummary();
    }
  }

  private shouldProcessXml(agentSetting: AgentWorkflowSetting): boolean {
    const xmlMode = agentSetting.xmlStructureMode ?? 'scratchpadOnly';

    switch (xmlMode) {
      case 'always':
        return true;
      case 'scratchpadOnly': {
        const hasDocumentTag = Boolean(agentSetting.documentTag);
        const hasScratchpadPrefill =
          agentSetting.prefills?.some((p) => SCRATCHPAD_TAG_PATTERN.test(p)) ??
          false;
        return hasDocumentTag || hasScratchpadPrefill;
      }
      default:
        return false;
    }
  }
}
