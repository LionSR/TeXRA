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
    try {
      // Start a dedicated processing group if none provided
      const cotProcessGroupId =
        processGroupId ||
        (await this.outputHandler.startProcessing(
          `ProcessXmlOutput`,
          this.logger.getActiveGroupId(),
        ));

      // Initialize output files array if needed
      this.outputHandler.outputFiles[currRound] =
        this.outputHandler.outputFiles[currRound] || [];

      if (endTurn) {
        this.logger.debug(
          `Processing output for round ${currRound}`,
          cotProcessGroupId,
        );

        // Process XML structure first
        await this.outputHandler.ensureCorrectXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );
        this.logger.debug(
          `XML structure processed for round ${currRound}`,
          cotProcessGroupId,
        );

        // Then process output files
        await this.processOutputFiles(outputFile, currRound);
        this.logger.info(
          `Output files processed for round ${currRound}`,
          cotProcessGroupId,
        );
      }

      // Finally handle logging in base class (but pass our group ID)
      const result = await super.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
        cotProcessGroupId,
      );

      // Only end the processing group if we created it
      if (!processGroupId) {
        this.outputHandler.endProcessing('stopped');
      }

      return result;
    } catch (err) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${err}`,
        processGroupId,
      );

      // Only end the processing group if we created it
      if (!processGroupId) {
        this.outputHandler.endProcessing('error');
      }

      throw err; // Re-throw to maintain error propagation
    }
  }
}
