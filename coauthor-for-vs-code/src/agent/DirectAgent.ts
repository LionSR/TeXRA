// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { BaseReflectionAgent } from './BaseReflectionAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

/**
 * Direct agent implementation that processes requests in a single pass.
 * Extends BaseReflectionAgent with simplified output handling and no intermediate steps.
 */
export class DirectAgent extends BaseReflectionAgent {
  /**
   * Generates output file name based on configuration and current round.
   * @param currRound Current round number in the conversation
   * @returns Formatted output file path incorporating model and round information
   */
  protected getOutputFile(currRound: number): string {
    const baseOutputFile =
      this.agentConfig.outputNameOverride || this.agentConfig.inputFile;
    return getOutputFileName(
      baseOutputFile,
      this.agentConfig.agent,
      this.modelHandler.config.name,
      this.agentSetting.outputExt,
      currRound,
      this.agentConfig.editedFile || undefined,
    );
  }

  /**
   * Processes output for the current round with minimal processing.
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
  ): Promise<string[]> {
    // Initialize output files array if needed
    this.outputHandler.outputFiles[currRound] =
      this.outputHandler.outputFiles[currRound] || [];

    if (endTurn) {
      await this.processOutputFiles(outputFile, currRound);
    }

    // Let base class handle logging
    return await super.handleOutput(
      stateRound,
      stateGlobal,
      outputFile,
      endTurn,
      currRound,
    );
  }
}
