// Local imports - agent components
import { BaseReflectionAgent } from './BaseReflectionAgent';
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
import { getOutputFileName } from '@agent/output';

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
    const baseOutputFile = this.agentConfig.inputFile;
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
    currRound: number = 0,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: {
      outputFile: string;
      endTurn: boolean;
      processGroupId?: string;
    },
  ): Promise<string[]> {
    // Declare the process group ID at the function scope level
    // Initialize with options.processGroupId if provided, otherwise it will be set in the try block
    let outputProcessGroupId: string = options.processGroupId || '';

    // These groups needs to be made consistent with the @BaseReflectionAgent.handleOutput method
    try {
      // Start a main output processing group if none provided
      if (!options.processGroupId) {
        outputProcessGroupId = await this.logger.startGroup(
          `OutputProcessing-Round${currRound}`,
          undefined,
          this.logger.getActiveGroupId(),
        );
      }

      // Initialize output files array if needed
      this.outputHandler.outputFiles[currRound] =
        this.outputHandler.outputFiles[currRound] || [];

      if (options.endTurn) {
        this.logger.debug(
          `Processing output for round ${currRound}`,
          outputProcessGroupId,
        );

        // Process output files using the output handler
        await this.outputHandler.processOutputFiles(
          options.outputFile,
          currRound,
          outputProcessGroupId,
        );
        this.logger.debug(
          `Output files processed for round ${currRound}`,
          outputProcessGroupId,
        );

        // Note: latexdiff processing is now handled in the parent class's handleOutput method
      }

      // Finally handle statistics in base class (but pass our group ID)
      const result = await super.handleOutput(
        currRound,
        stateRound,
        stateGlobal,
        {
          outputFile: options.outputFile,
          endTurn: options.endTurn,
          processGroupId: outputProcessGroupId,
        },
      );

      // Only end the processing group if we created it
      if (!options.processGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'stopped');
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Error in DirectAgent.handleOutput: ${error}`,
        options.processGroupId,
      );

      // Only end the processing group if we created it and we have a valid outputProcessGroupId
      if (!options.processGroupId && outputProcessGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'error');
      }

      throw error;
    }
  }
}
