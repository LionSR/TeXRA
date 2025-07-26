// Standard library imports
// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - utilities
import { runLatexFormatter } from '@latex/texFormatter';
import { LatexMediaManager } from '@latex';
import { XmlOutputManager } from './XmlOutputManager';
import { LatexDiffManager } from './LatexDiffManager';
import { StatisticsReporter } from './StatisticsReporter';
import { DiffStatsManager } from './DiffStatsManager';
import { NamedOutputFile } from './types';
import type { IOutputHandler } from './IOutputHandler';
import { getOutputFileName } from '@agent/utils/outputFileUtils';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import type { IModelHandler } from '@agent/modelHandlers';
import { ToolState } from '@agent/core/ToolState';

// Local imports - utilities
import { replaceInputCommands, createFileMapping } from '@utils/files';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { getEffectiveBaseFile } from '@utils/files/baseFileUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';

// Local imports - types

/** Handles output file processing and validation for agent responses. */
export class OutputHandler implements IOutputHandler {
  public agentSetting: AgentSetting;
  public agentConfig: AgentConfig;
  public modelHandler: IModelHandler;
  public logId: number;
  public outputFiles: { [key: number]: string[] };
  public outputMappings: { [key: number]: NamedOutputFile[] };
  public baseFiles: string[];
  public processGroupId?: string;
  protected logger: AgentLogger;
  protected channel: string;
  public readonly xmlManager: XmlOutputManager;
  private diffManager: LatexDiffManager;
  private statsReporter: StatisticsReporter;
  private diffStatsManager: DiffStatsManager;
  private latexMediaManager: LatexMediaManager;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    modelHandler: IModelHandler,
    logId: number,
    baseFiles: string[] = [],
    logger?: AgentLogger,
  ) {
    this.agentSetting = agentSetting;
    this.agentConfig = agentConfig;
    this.modelHandler = modelHandler;
    this.logId = logId;
    this.outputFiles = { 0: [], 1: [] };
    this.outputMappings = { 0: [], 1: [] };
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
    this.statsReporter = new StatisticsReporter(
      this.modelHandler,
      this.channel,
      this.logger,
    );
    this.diffStatsManager = new DiffStatsManager();
    this.latexMediaManager = new LatexMediaManager(this.logger);
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
    await this.diffManager.handleLatexdiffofOutput(currRound, groupId);
  }

  /**
   * Gather mapping and diff statistics for output files of a round.
   */
  public async gatherOutputFileInfo(currRound: number): Promise<
    {
      path: string;
      base: string | null;
      prev: string | null;
      original: string | null;
      added?: number;
      removed?: number;
    }[]
  > {
    const roundOutputs = this.outputFiles[currRound] || [];
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

    const infos = [] as any[];
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

  /**
   * Update tool state with information from output files.
   */
  public async handleToolStateForOutput(
    outputFiles: string[],
    toolState: ToolState,
    groupId?: string,
  ): Promise<void> {
    await this.latexMediaManager.processOutputFiles(
      outputFiles,
      toolState,
      this.agentConfig.toolConfig,
      this.modelHandler.capabilities.supportsVision,
      groupId ?? this.logger.getActiveGroupId(),
    );
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

  /** Prints statistics about token usage and costs */
  public async printStatistics(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void> {
    await this.statsReporter.printStatistics(stateGlobal, groupId);
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
        if (this.agentSetting.agentType === AgentType.CoT) {
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
    // Print statistics at the end of each round
    await this.printStatistics(stateGlobal, roundGroupId);

    return this.outputFiles[currRound] || [];
  }
}

export { NamedOutputFile };
export { getOutputFileName } from '@agent/utils/outputFileUtils';
