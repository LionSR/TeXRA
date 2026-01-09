import * as path from 'path';

import {
  AgentType,
  type AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import type { AgentLogger, AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  replaceInputCommands,
  flexibleFS,
  type FileLocation,
} from '@utils/files';
import {
  extractMultipleTextFromTag,
  extractTextFromTag,
} from '@utils/text/xmlUtils';
import { bus } from '@eventBus/ProgressEventBus';

import {
  indentLatexFile,
  indentLatexFiles,
  cleanupLatexBackups,
} from './LatexOutputUtils';
import type { XmlOutputManager } from './XmlOutputManager';
import type { OutputFileInfo, OutputXmlSummary } from './types';

export interface ProcessingContext {
  agentSetting: AgentWorkflowSetting;
  baseFiles: FileLocation[];
  channel: string;
  logger: AgentLogger;
  xmlManager: XmlOutputManager;
  setRoundOutputs: (round: number, outputs: OutputFileInfo[]) => void;
  ensureRoundData: (round: number) => { xmlSummary: OutputXmlSummary };
}

export interface StoragePayload {
  storageKey: StorageKey;
  executionId: string | undefined;
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
      const processedPairs =
        await xmlManager.processMultipleXmlOutputs(outputLocation);

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
      logger.debug(`Error processing output files: ${toErrorMessage(err)}`, {
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      this.ctx.setRoundOutputs(currRound, []);
      await cleanupLatexBackups(rawLocation, logger);
      await this.captureXmlSummary(currRound, rawLocation, [], scope);
    }
  }

  async processSingleOutput(
    outputLocation: FileLocation,
    currRound: number,
    rawLocation: FileLocation,
    storagePayload: StoragePayload,
    scope: AgentLogStage,
  ): Promise<void> {
    const { agentSetting, logger, xmlManager, baseFiles, channel } = this.ctx;

    logger.debug(`Processing single output for ${outputLocation.absolutePath}`);

    try {
      const processedLocation = rawLocation ?? outputLocation;
      let processed: OutputFileInfo = {
        source: path.basename(outputLocation.absolutePath),
        location: processedLocation,
        lineage: null,
        diff: null,
      };

      const hasScratchpadPrefill =
        agentSetting.prefills?.some((prefill) =>
          /<scratchpad\s*>/i.test(prefill),
        ) ?? false;
      const hasDocumentTag = Boolean(agentSetting.documentTag);
      const shouldProcessXml =
        agentSetting.agentType === AgentType.CoT ||
        (agentSetting.agentType === AgentType.Direct &&
          (hasDocumentTag || hasScratchpadPrefill));

      if (shouldProcessXml) {
        processed = await xmlManager.processSingleXmlOutput(outputLocation);
      }

      const hasProcessedPath = Boolean(processed.location.absolutePath);

      if (hasProcessedPath) {
        await indentLatexFile(processed.location, logger);
        logger.debug(
          `Indented single output file: ${processed.location.absolutePath}`,
        );
      }

      const processedFiles = hasProcessedPath ? [processed] : [];

      if (hasProcessedPath) {
        if (baseFiles.length > 0) {
          await replaceInputCommands(
            baseFiles,
            processedFiles.map((entry) => entry.location),
            logger,
          );
        }
        this.ctx.setRoundOutputs(currRound, processedFiles);
      } else {
        logger.debug(
          `No processed file was generated from ${outputLocation.absolutePath}`,
        );
        this.ctx.setRoundOutputs(currRound, []);
      }

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
        stream: channel,
        ...storagePayload,
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
    const { agentSetting, logger } = this.ctx;

    const run = async () => {
      const singleFile =
        processed.length === 1 ? processed[0].location.absolutePath : null;
      const data = this.ctx.ensureRoundData(round);
      const sourceLocation = rawOutput ?? null;

      if (!rawOutput?.absolutePath) {
        data.xmlSummary = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
          sourceLocation,
        };
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
          const trimmedDocuments = documentEntries.map((entry) =>
            entry.content.trim(),
          );
          if (trimmedDocuments.length === 1) {
            tagContents[documentTag] = trimmedDocuments[0];
          } else {
            tagContents[documentTag] = trimmedDocuments;
          }

          for (const entry of documentEntries) {
            const nameAttr = entry.name ? ` name="${entry.name}"` : '';
            const trimmed = entry.content.trim();
            documents.push(
              `<${documentTag}${nameAttr}>${trimmed}</${documentTag}>`,
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
          sourceLocation,
        };
      } catch (error) {
        logger.debug(
          `Failed to collect XML summary for round ${round}: ${toErrorMessage(error)}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
        data.xmlSummary = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
          sourceLocation,
        };
      }
    };

    if (stage) {
      await stage.within(run);
      return;
    }

    await run();
  }
}
