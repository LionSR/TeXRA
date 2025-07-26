// Standard library imports
// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import * as path from 'path';

// Local imports - utilities
import { XmlOutputManager } from './XmlOutputManager';
import { LatexDiffManager } from './LatexDiffManager';
import { DiffStatsManager } from './DiffStatsManager';
import { OutputProcessor } from './OutputProcessor';
import { NamedOutputFile } from './types';
import type { IOutputHandler } from './IOutputHandler';
import { getOutputFileName } from '@agent/utils/outputFileUtils';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting } from '@agent/core/AgentDataclass';
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';

// Local imports - utilities
import { createFileMapping } from '@utils/files';
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
  public logId: number;
  public outputFiles: { [key: number]: string[] };
  public outputMappings: { [key: number]: NamedOutputFile[] };
  public baseFiles: string[];
  public processGroupId?: string;
  protected logger: AgentLogger;
  protected channel: string;
  public readonly outputProcessor: OutputProcessor;
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
    this.agentSetting = agentSetting;
    this.agentConfig = agentConfig;
    this.logId = logId;
    this.outputFiles = { 0: [], 1: [] };
    this.outputMappings = { 0: [], 1: [] };
    this.baseFiles = baseFiles;
    this.logger = logger || new AgentLogger('OutputHandler');
    this.channel = this.logger.channelId;

    this.outputProcessor = new OutputProcessor(
      this.agentSetting,
      this.agentConfig,
      this.baseFiles,
      this.logger,
    );
    this.xmlManager = this.outputProcessor.xmlManager;
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
    const { files, mappings } = await this.outputProcessor.processOutputFiles(
      outputFile,
      activeGroupId,
    );

    if (
      files.length === 0 &&
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      bus.emit('updateMissingOutputs', {
        stream: this.channel,
        filesByRound: { [currRound]: [] },
      });
    }

    this.outputFiles[currRound] = files;
    this.outputMappings[currRound] = mappings;
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
    return this.outputFiles[currRound] || [];
  }
}

export { NamedOutputFile };
export { getOutputFileName } from '@agent/utils/outputFileUtils';
