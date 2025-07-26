// Standard library imports

// Local imports - utilities
import { runLatexFormatter } from '@latex/texFormatter';
import { replaceInputCommands } from '@utils/files';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { AgentLogger } from '@logger/AgentLogger';

import { XmlOutputManager } from './XmlOutputManager';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { NamedOutputFile } from './types';

/**
 * Handles splitting and formatting of agent output files.
 */
export class OutputProcessor {
  public readonly xmlManager: XmlOutputManager;

  constructor(
    private readonly agentSetting: AgentSetting,
    private readonly agentConfig: AgentConfig,
    private readonly baseFiles: string[],
    private readonly logger: AgentLogger,
  ) {
    this.xmlManager = new XmlOutputManager(
      this.agentSetting,
      this.agentConfig,
      this.logger,
    );
  }

  private async indentLatexFile(filePath: string): Promise<void> {
    if (!filePath.includes('.tex')) {
      return;
    }
    this.logger.debug(`Formatting ${filePath}`);
    await runLatexFormatter(filePath);
  }

  private async indentLatexFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.indentLatexFile(filePath);
    }
  }

  /**
   * Split XML outputs and indent generated TeX files.
   * Returns processed paths and mappings.
   */
  public async processOutputFiles(
    outputFile: string,
    groupId?: string,
  ): Promise<{ files: string[]; mappings: NamedOutputFile[] }> {
    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      // Multiple output files case
      this.logger.debug(
        `Processing multiple outputs for ${outputFile}; outputFiles: ${this.agentConfig.outputFiles}`,
        groupId,
      );

      try {
        const processedPairs =
          await this.xmlManager.processMultipleXmlOutputs(outputFile);

        if (processedPairs && processedPairs.length > 0) {
          const processedFiles = processedPairs.map((p) => p.path);
          await this.indentLatexFiles(processedFiles);

          if (this.baseFiles && this.baseFiles.length > 0) {
            await replaceInputCommands(
              this.baseFiles,
              processedFiles,
              this.logger,
            );
          }

          return { files: processedFiles, mappings: processedPairs };
        }

        this.logger.debug(
          `No processed files were generated from ${outputFile}`,
          groupId,
        );
        return { files: [], mappings: [] };
      } catch (err) {
        this.logger.debug(
          `Error processing output files: ${err instanceof Error ? err.message : String(err)}`,
          groupId,
          MESSAGE_TYPES.INTERNAL,
        );
        return { files: [], mappings: [] };
      }
    } else {
      // Single output file case
      this.logger.debug(`Processing single output for ${outputFile}`, groupId);

      try {
        let processed: NamedOutputFile = {
          source: outputFile,
          path: outputFile,
        };
        if (this.agentSetting.agentType === AgentType.CoT) {
          processed = await this.xmlManager.processSingleXmlOutput(outputFile);
        }

        if (processed && processed.path) {
          await this.indentLatexFile(processed.path);
          return { files: [processed.path], mappings: [processed] };
        }

        this.logger.debug(
          `No processed file was generated from ${outputFile}`,
          groupId,
        );
        return { files: [], mappings: [] };
      } catch (err) {
        this.logger.debug(
          `Error processing output file: ${err instanceof Error ? err.message : String(err)}`,
          groupId,
          MESSAGE_TYPES.INTERNAL,
        );
        return { files: [], mappings: [] };
      }
    }
  }
}

export type { NamedOutputFile } from './types';
