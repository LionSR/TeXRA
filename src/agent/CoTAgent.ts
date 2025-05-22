// Local imports - agent components
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';
import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Chain of Thought (CoT) agent implementation that extends BaseReflectionAgent.
 * Adds XML structure validation and specialized output handling for multi-step reasoning.
 */
export class CoTAgent extends BaseReflectionAgent {
  /**
   * Generates output file name based on configuration and current round.
   * @param currRound Current round number in the conversation
   * @returns Formatted output file path incorporating model and round information
   */
  protected getOutputFile(currRound: number): string {
    const baseOutputFile =
      this.agentConfig.outputNameOverride || this.agentConfig.inputFile;
    const fileExtension = this.useScratchpad
      ? 'xml'
      : this.agentSetting.outputExt;
    return getOutputFileName(
      baseOutputFile,
      this.agentConfig.agent,
      this.modelHandler.config.name,
      fileExtension,
      currRound,
      this.agentConfig.editedFile || undefined,
    );
  }

  /**
   * Processes output for the current round with XML validation.
   * Ensures proper sequencing of XML processing, file processing, and logging.
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

        // Create a single subgroup for XML and file handling
        const fileProcessGroupId = await this.outputHandler.startProcessing(
          `XML/File Processing`,
          outputProcessGroupId,
        );

        // First fix XML structure
        await this.outputHandler.ensureCorrectXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );
        this.logger.debug(
          `XML structure processed for round ${currRound}`,
          fileProcessGroupId,
        );

        // Then process output files using the parent class method but with our group ID
        await super.processOutputFiles(
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
    } catch (err) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${err}`,
        processGroupId,
      );

      // Only end the processing group if we created it and we have a valid outputProcessGroupId
      if (!processGroupId && outputProcessGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'error');
      }

      throw err; // Re-throw to maintain error propagation
    }
  }
}
