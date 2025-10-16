// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { DiffStatsManager } from './DiffStatsManager';
import type { IOutputHandler } from './IOutputHandler';
import { LatexDiffManager } from './LatexDiffManager';
import type { NamedOutputFile, OutputFileInfo } from './types';
import { XmlOutputManager } from './XmlOutputManager';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentType,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';

// Local imports - utilities
import { runLatexFormatter } from '@latex/texFormatter';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - utilities
import { replaceInputCommands, createFileMapping } from '@utils/files';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { getEffectiveBaseFile } from '@utils/files/baseFileUtils';

// Local imports - types

/** Handles output file processing and validation for agent responses. */
export class OutputHandler implements IOutputHandler {
  public agentSetting: AgentWorkflowSetting;
  public agentConfig: AgentConfig;
  public logId: number;
  public outputFiles: { [key: number]: string[] };
  public outputMappings: { [key: number]: NamedOutputFile[] };
  public baseFiles: string[];
  public processGroupId?: string;
  protected logger: AgentLogger;
  protected channel: string;
  public readonly xmlManager: XmlOutputManager;
  private diffManager: LatexDiffManager;
  private diffStatsManager: DiffStatsManager;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    logId: number,
    baseFiles: string[] = [],
    logger?: AgentLogger,
  ) {
    this.agentSetting = requireWorkflowSetting(agentSetting);
    this.agentConfig = agentConfig;
    this.logId = logId;
    this.outputFiles = {};
    this.outputMappings = {};
    this.baseFiles = baseFiles;
    this.logger = logger || new AgentLogger('OutputHandler');
    this.channel = this.logger.channelId;

    this.xmlManager = new XmlOutputManager(
      this.agentSetting,
      this.agentConfig,
      this.logger,
    );
    this.diffManager = new LatexDiffManager(
      this.agentSetting,
      this.outputFiles,
      this.baseFiles,
      this.logger,
      this.channel,
    );
    this.diffStatsManager = new DiffStatsManager();
  }

  /**
   * Ensure that storage exists for a round and return its output list.
   * @param round The round index to initialize.
   * @returns The mutable list of outputs for the round.
   */
  public ensureRound(round: number): string[] {
    if (!this.outputFiles[round]) {
      this.outputFiles[round] = [];
    }
    if (!this.outputMappings[round]) {
      this.outputMappings[round] = [];
    }
    return this.outputFiles[round];
  }

  /**
   * Retrieve the list of outputs for a round, initializing it if needed.
   * @param round The round index to read.
   * @returns The list of outputs associated with the round.
   */
  public getRoundOutputs(round: number): string[] {
    return this.ensureRound(round);
  }

  /**
   * Check if a round has any generated outputs.
   * @param round The round index to inspect.
   * @returns True when the round has at least one output.
   */
  public hasRoundOutputs(round: number): boolean {
    const outputs = this.outputFiles[round];
    return Array.isArray(outputs) && outputs.length > 0;
  }

  /**
   * Starts a processing group for output handling.
   * Creates a log group at the same level as ResponseCycle.
   * @param processName Name of the processing operation
   * @param roundGroupId Parent round group ID
   * @returns The created process group ID
   */
  async startProcessing(
    processName: string,
    roundGroupId?: string,
  ): Promise<string> {
    // Create a log group as a child of the round group if provided
    const groupName = `OutputHandler: ${processName}`;
    const groupId = await this.logger.startGroup(
      groupName,
      undefined,
      roundGroupId,
    );
    // Comment out this line as it creates confusing log order
    // this.logger.info(`Starting ${processName}`, groupId);
    return groupId;
  }

  /**
   * Ends the current processing group.
   * @param status Status of the processing (error or stopped)
   */
  endProcessing(
    status: 'error' | 'stopped' = 'stopped',
    groupId?: string,
  ): void {
    if (groupId) {
      this.logger.endGroup(groupId, status);
    } else if (this.processGroupId) {
      // this.logger.info(`Completed output processing`, this.processGroupId);
      this.logger.endGroup(this.processGroupId, status);
      this.processGroupId = undefined;
    }
  }

  /**
   * Indents a LaTeX file for better readability
   */
  public async indentLatexFile(filePath: string): Promise<void> {
    if (!filePath.includes('.tex')) {
      return;
    }
    this.logger.debug(`Formatting ${filePath}`);
    await runLatexFormatter(filePath);
  }

  /**
   * Indents multiple LaTeX files for better readability
   */
  public async indentLatexFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.indentLatexFile(filePath);
    }
  }

  /**
   * Helper method to log latexdiff results with appropriate level
   * @param result The result of a latexdiff operation
   * @param operation Description of the operation being performed
   * @param groupId The group ID for logging context
   */

  /**
   * Runs all latexdiff comparisons for the current round.
   * This is the ONLY place where latexdiff operations should be performed.
   *
   * Generates two types of diffs:
   * 1. Round diffs: Between original input and current output (when in rewrite mode)
   * 2. Between-rounds diffs: Comparing previous round to current round (when applicable)
   *
   */
  public async handleLatexdiffofOutput(
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    this.ensureRound(currRound);
    await this.diffManager.handleLatexdiffofOutput(currRound, groupId);
  }

  /**
   * Gather mapping and diff statistics for output files of a round.
   */
  public async gatherOutputFileInfo(
    currRound: number,
  ): Promise<OutputFileInfo[]> {
    const roundOutputs = this.getRoundOutputs(currRound);
    const baseMap = createFileMapping(this.baseFiles, roundOutputs, 'contains');
    const prevMap =
      currRound > 0
        ? createFileMapping(
            this.outputFiles[currRound - 1] || [],
            roundOutputs,
            'basename',
            true,
          )
        : new Map<string, string>();
    const originMap = new Map(
      (this.outputMappings[currRound] || []).map((p) => [p.path, p.source]),
    );

    const infos: OutputFileInfo[] = [];
    for (const file of roundOutputs) {
      const baseFile =
        Array.from(baseMap.entries()).find(([, out]) => out === file)?.[0] ||
        null;
      const prevFile =
        Array.from(prevMap.entries()).find(([, out]) => out === file)?.[0] ||
        null;
      const originalFile = originMap.get(file) || null;
      const diffBase = getEffectiveBaseFile(baseFile, originalFile, file);
      const stats = await this.diffStatsManager.computeDiffStats(
        diffBase,
        file,
      );
      infos.push({
        path: file,
        base: baseFile,
        prev: prevFile,
        original: originalFile,
        ...stats,
      });
    }
    return infos;
  }

  public async validateExpectedOutputs(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    const expected = this.agentConfig.outputFiles;
    if (!expected || expected.length === 0) {
      bus.emit('updateMissingOutputs', {
        stream: this.channel,
        filesByRound: { [currRound]: [] },
      });
      return;
    }

    const checks = expected.map(async (file) => ({
      file,
      exists: path.isAbsolute(file)
        ? await AbsoluteFS.exists(file)
        : await WorkspaceFS.exists(file),
    }));
    const results = await Promise.all(checks);
    const missing = results.filter((r) => !r.exists).map((r) => r.file);

    // Include XML file path with missing outputs if there are any missing files
    if (missing.length > 0) {
      let xmlPath: string;

      if (outputFile) {
        // Use the provided outputFile parameter which contains the actual XML file path
        xmlPath = outputFile;
      } else {
        // Fallback: construct the expected XML file path using the same naming convention
        xmlPath = getOutputFileName(
          this.agentConfig.inputFile,
          this.agentConfig.agent,
          this.agentConfig.model,
          'xml',
          currRound,
        );
      }

      // Check if XML file exists
      const xmlExists = path.isAbsolute(xmlPath)
        ? await AbsoluteFS.exists(xmlPath)
        : await WorkspaceFS.exists(xmlPath);

      // Log missing outputs with XML file info
      const missingOutputsData = {
        missing,
        xmlFile: xmlExists ? xmlPath : null,
        documentTag: this.agentSetting.documentTag,
      };

      this.logger.missingOutputs(missingOutputsData, groupId);
    }

    bus.emit('updateMissingOutputs', {
      stream: this.channel,
      filesByRound: { [currRound]: missing },
    });
  }

  /**
   * Finalize processing for a conversation round.
   * Gathers file info, validates expected outputs and
   * emits an event with the collected files.
   */
  public async finalizeRound(
    outputFile: string,
    currRound: number,
    options: { endTurn: boolean; groupId?: string },
  ): Promise<void> {
    const { endTurn, groupId } = options;
    this.ensureRound(currRound);
    const fileInfos = await this.gatherOutputFileInfo(currRound);

    if (endTurn) {
      try {
        await this.validateExpectedOutputs(outputFile, currRound, groupId);
        this.logger.debug(
          `Expected outputs validated for round ${currRound}`,
          groupId,
        );
      } catch (error) {
        this.logger.error(
          `Expected output validation failed after round ${currRound}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          groupId,
        );
      }
    }

    bus.emit('addOutputFiles', {
      stream: this.channel,
      filesByRound: { [currRound]: fileInfos },
    });
  }

  /**
   * Processes output files from XML or direct input.
   */
  public async processOutputFiles(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    const activeGroupId = groupId || this.logger.getActiveGroupId();
    this.ensureRound(currRound);

    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      // Multiple output files case
      this.logger.debug(
        `Processing multiple outputs for ${outputFile}; outputFiles: ${this.agentConfig.outputFiles}`,
        activeGroupId,
      );

      try {
        const processedPairs =
          await this.xmlManager.processMultipleXmlOutputs(outputFile);

        if (processedPairs && processedPairs.length > 0) {
          const processedFiles = processedPairs.map((p) => p.path);
          await this.indentLatexFiles(processedFiles);
          this.logger.debug(
            `Indented multiple output files: ${processedFiles.join(',')}`,
            activeGroupId,
          );

          this.outputFiles[currRound] = processedFiles;
          this.outputMappings[currRound] = processedPairs;

          if (this.baseFiles && this.baseFiles.length > 0) {
            await replaceInputCommands(
              this.baseFiles,
              processedFiles,
              this.logger,
            );
          }
        } else {
          this.logger.debug(
            `No processed files were generated from ${outputFile}`,
            activeGroupId,
          );
          this.outputFiles[currRound] = [];
          this.outputMappings[currRound] = [];
        }
      } catch (err) {
        this.logger.debug(
          `Error processing output files: ${err instanceof Error ? err.message : String(err)}`,
          activeGroupId,
          MESSAGE_TYPES.INTERNAL,
        );
        this.outputFiles[currRound] = [];
        this.outputMappings[currRound] = [];
      }
    } else {
      // Single output file case
      this.logger.debug(
        `Processing single output for ${outputFile}`,
        activeGroupId,
      );

      try {
        let processed: NamedOutputFile = {
          source: outputFile,
          path: outputFile,
        };
        const hasScratchpadPrefill =
          this.agentSetting.prefills?.some((prefill) =>
            /<scratchpad\s*>/i.test(prefill),
          ) ?? false;
        const shouldProcessXml =
          this.agentSetting.agentType === AgentType.CoT ||
          (this.agentSetting.agentType === AgentType.Direct &&
            hasScratchpadPrefill);

        if (shouldProcessXml) {
          processed = await this.xmlManager.processSingleXmlOutput(outputFile);
        }

        if (processed && processed.path) {
          await this.indentLatexFile(processed.path);
          this.logger.debug(
            `Indented single output file: ${processed.path}`,
            activeGroupId,
          );

          this.outputFiles[currRound] = [processed.path];
          this.outputMappings[currRound] = [processed];
        } else {
          this.logger.debug(
            `No processed file was generated from ${outputFile}`,
            activeGroupId,
          );
          this.outputFiles[currRound] = [];
          this.outputMappings[currRound] = [];
        }
      } catch (err) {
        this.logger.debug(
          `Error processing output file: ${err instanceof Error ? err.message : String(err)}`,
          activeGroupId,
          MESSAGE_TYPES.INTERNAL,
        );
        const missingOutputsData = {
          missing: [],
          xmlFile: outputFile,
          documentTag: this.agentSetting.documentTag,
        };
        this.logger.missingOutputs(missingOutputsData, activeGroupId);
        bus.emit('updateMissingOutputs', {
          stream: this.channel,
          filesByRound: { [currRound]: [] },
        });
        this.outputFiles[currRound] = [];
        this.outputMappings[currRound] = [];
      }
    }
  }
  /** Processes output files for current round. */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
    roundGroupId?: string,
  ): Promise<string[]> {
    this.ensureRound(currRound);
    return this.outputFiles[currRound];
  }
}

export { NamedOutputFile };
export { getOutputFileName } from '@agent/utils/outputFileUtils';
