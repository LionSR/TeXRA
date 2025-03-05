// Local imports - agent components
import { BaseReflectionAgent } from './BaseReflectionAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';

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
    processGroupId?: string,
  ): Promise<string[]> {
    // Declare the process group ID at the function scope level
    // Initialize with processGroupId if provided, otherwise it will be set in the try block
    let outputProcessGroupId: string = processGroupId || '';

    try {
      // Start a main output processing group if none provided
      if (!processGroupId) {
        outputProcessGroupId = await this.logger.startGroup(
          `OutputProcessing-Round${currRound}`,
          undefined,
          this.logger.getActiveGroupId(),
        );
      }

      // Initialize output files array if needed
      this.outputHandler.outputFiles[currRound] =
        this.outputHandler.outputFiles[currRound] || [];

      if (endTurn) {
        this.logger.debug(
          `Processing output for round ${currRound}`,
          outputProcessGroupId,
        );

        // Create a dedicated File Processing subgroup
        const fileProcessGroupId = await this.outputHandler.startProcessing(
          `FileProcessing`,
          outputProcessGroupId,
        );

        // Process output files using the parent class method but with our group ID
        await this.processOutputFiles(
          outputFile,
          currRound,
          fileProcessGroupId,
        );
        this.logger.info(
          `Output files processed for round ${currRound}`,
          fileProcessGroupId,
        );

        // End File Processing subgroup
        this.outputHandler.endProcessing('stopped', fileProcessGroupId);

        // Note: latexdiff processing is now handled in the parent class's handleOutput method
      }

      // Finally handle statistics in base class (but pass our group ID)
      const result = await super.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
        outputProcessGroupId, // The statistics will be a subgroup of our output processing group
      );

      // Only end the processing group if we created it
      if (!processGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'stopped');
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Error in DirectAgent.handleOutput: ${error}`,
        processGroupId,
      );

      // Only end the processing group if we created it and we have a valid outputProcessGroupId
      if (!processGroupId && outputProcessGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'error');
      }

      throw error;
    }
  }
}
