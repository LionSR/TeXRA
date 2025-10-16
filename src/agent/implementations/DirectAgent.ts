// Local imports - agent
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
// Local imports - agent components
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';
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
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ): Promise<string[]> {
    const { outputFile, endTurn, processGroupId } = options;
    // Declare the process group ID at the function scope level
    // Initialize with processGroupId if provided, otherwise it will be set in the try block
    let outputProcessGroupId: string = processGroupId || '';

    // These groups needs to be made consistent with the @BaseReflectionAgent.handleOutput method
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
      this.outputHandler.ensureRound(currRound);

      if (endTurn) {
        this.logger.debug(
          `Processing output for round ${currRound}`,
          outputProcessGroupId,
        );

        // I do not think DirectAgent should ever use scratchpad;
        if (this.useScratchpad) {
          await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
            outputFile,
            this.agentSetting.documentTag,
          );
        }

        // Process output files using the output handler
        await this.outputHandler.processOutputFiles(
          outputFile,
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
          outputFile,
          endTurn,
          processGroupId: outputProcessGroupId,
        },
      );

      // Only end the processing group if we created it
      // Maybe this kind of setup is more graceful to do a withGroup kind of function?
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
