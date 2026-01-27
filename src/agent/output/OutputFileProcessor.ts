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
import type { AgentLogger, AgentLogStage } from '@logger/AgentLogger';
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
    scope: AgentLogStage,
  ): Promise<void> {
    const { logger, xmlManager, baseFiles } = this.ctx;

    logger.debug(
      `Processing multiple outputs for ${outputLocation.absolutePath}`,
    );

    try {
      const processedPairs = await xmlManager.processMultipleXmlOutputs(
        outputLocation,
        currRound,
      );

      if (processedPairs.length > 0) {
        await indentLatexFiles(
          processedPairs.map((p) => p.location),
          logger,
        );
        logger.debug(
          `Indented multiple output files: ${processedPairs.map((p) => p.location.absolutePath).join(',')}`,
        );

        if (baseFiles.length > 0) {
          await replaceInputCommands(
            baseFiles,
            processedPairs.map((p) => p.location),
            logger,
          );
        }
        this.ctx.setRoundOutputs(currRound, processedPairs);
        await this.captureXmlSummary(
          currRound,
          rawLocation,
          processedPairs,
          scope,
        );
        return;
      }

      logger.debug(
        `No processed files were generated from ${outputLocation.absolutePath}`,
      );
      this.ctx.setRoundOutputs(currRound, []);
      await cleanupLatexBackups(rawLocation, logger);
      await this.captureXmlSummary(currRound, rawLocation, [], scope);
    } catch (err) {
      await this.handleOutputProcessingError(
        err,
        currRound,
        rawLocation,
        scope,
      );
    }
  }

  private async handleOutputProcessingError(
    err: unknown,
    currRound: number,
    rawLocation: FileLocation,
    scope: AgentLogStage,
  ): Promise<void> {
    this.ctx.logger.debug(
      `Error processing output file: ${toErrorMessage(err)}`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
    this.ctx.setRoundOutputs(currRound, []);
    await cleanupLatexBackups(rawLocation, this.ctx.logger);
    await this.captureXmlSummary(currRound, rawLocation, [], scope);
  }

  async processSingleOutput(
    outputLocation: FileLocation,
    currRound: number,
    rawLocation: FileLocation,
    storageKey: StorageKey,
    scope: AgentLogStage,
  ): Promise<void> {
    const { agentSetting, logger, xmlManager, baseFiles, streamId } = this.ctx;

    logger.debug(`Processing single output for ${outputLocation.absolutePath}`);

    try {
      const processedLocation = rawLocation ?? outputLocation;
      let processed: OutputFileInfo = {
        source: path.basename(outputLocation.absolutePath),
        round: currRound,
        location: processedLocation,
        lineage: null,
        diff: null,
      };

      const xmlMode = agentSetting.xmlStructureMode ?? 'scratchpadOnly';
      let shouldProcessXml = false;
      switch (xmlMode) {
        case 'always':
          shouldProcessXml = true;
          break;
        case 'scratchpadOnly': {
          const hasDocumentTag = Boolean(agentSetting.documentTag);
          const hasScratchpadPrefill =
            agentSetting.prefills?.some((p) =>
              SCRATCHPAD_TAG_PATTERN.test(p),
            ) ?? false;
          shouldProcessXml = hasDocumentTag || hasScratchpadPrefill;
          break;
        }
        case 'never':
          break;
      }

      if (shouldProcessXml) {
        processed = await xmlManager.processSingleXmlOutput(
          outputLocation,
          currRound,
        );
      }

      const processedFiles = processed.location.absolutePath ? [processed] : [];

      if (processedFiles.length > 0) {
        await indentLatexFile(processed.location, logger);
        logger.debug(
          `Indented single output file: ${processed.location.absolutePath}`,
        );

        if (baseFiles.length > 0) {
          await replaceInputCommands(
            baseFiles,
            processedFiles.map((entry) => entry.location),
            logger,
          );
        }
      } else {
        logger.debug(
          `No processed file was generated from ${outputLocation.absolutePath}`,
        );
      }
      this.ctx.setRoundOutputs(currRound, processedFiles);

      await this.captureXmlSummary(
        currRound,
        rawLocation,
        processedFiles,
        scope,
      );
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
        streamId: streamId,
        storageKey,
        filesByRound: { [currRound]: [] },
      });
      this.ctx.setRoundOutputs(currRound, []);
      await this.captureXmlSummary(currRound, rawLocation, [], scope);
    }
  }

  async captureXmlSummary(
    round: number,
    rawOutput: FileLocation | null,
    processed: OutputFileInfo[],
    stage?: AgentLogStage,
  ): Promise<void> {
    const execute = () => this.buildXmlSummary(round, rawOutput, processed);
    await (stage ? stage.within(execute) : execute());
  }

  private async buildXmlSummary(
    round: number,
    rawOutput: FileLocation | null,
    processed: OutputFileInfo[],
  ): Promise<void> {
    const { agentSetting, logger } = this.ctx;
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
      const documentTag = agentSetting.documentTag;

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
      logger.debug(
        `Failed to collect XML summary for round ${round}: ${toErrorMessage(error)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
      data.xmlSummary = createEmptySummary();
    }
  }
}
