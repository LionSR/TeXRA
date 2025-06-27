// Standard library imports
// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import { runLatexFormatter } from '@latex/texFormatter';
import { XmlOutputManager } from './XmlOutputManager';
import { LatexDiffManager } from './LatexDiffManager';
import { StatisticsReporter } from './StatisticsReporter';
import { NamedOutputFile } from './types';
import type { IOutputHandler } from './IOutputHandler';
import { getOutputFileName } from '@utils/outputFileUtils';

// Local imports - agent components
import { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting } from '@agent/core/AgentDataclass';
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import type { IModelHandler } from '@agent/modelHandlers';

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
  private xmlManager: XmlOutputManager;
  private diffManager: LatexDiffManager;
  private statsReporter: StatisticsReporter;

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

  /** Processes XML content by filtering tags and applying replacements. */
  public async processXmlContent(content: string): Promise<string> {
    return this.xmlManager.processXmlContent(content);
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

  /** Processes single output file with XML splitting and filtering. */
  public async processSingleXmlOutput(
    outputFile: string,
  ): Promise<NamedOutputFile> {
    return this.xmlManager.processSingleXmlOutput(outputFile);
  }

  /** Processes multiple output files with XML splitting and filtering. */
  public async processMultipleXmlOutputs(
    outputFile: string,
  ): Promise<NamedOutputFile[]> {
    return this.xmlManager.processMultipleXmlOutputs(outputFile);
  }
  async ensureCorrectXmlStructure(
    filePath: string,
    documentTag: string,
  ): Promise<void> {
    await this.xmlManager.ensureCorrectXmlStructure(filePath, documentTag);
  }

  /** Prints statistics about token usage and costs */
  public async printStatistics(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void> {
    await this.statsReporter.printStatistics(stateGlobal, groupId);
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
export { getOutputFileName } from '@utils/outputFileUtils';
