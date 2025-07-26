// Local imports - agent components
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
import { getOutputFileName } from '@agent/output';
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
    const baseOutputFile = this.agentConfig.inputFile;
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

        // First fix XML structure
        await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
          options.outputFile,
          this.agentSetting.documentTag,
        );

        // Then process output files using the output handler
        await this.outputHandler.processOutputFiles(
          options.outputFile,
          currRound,
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
    } catch (err) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${err}`,
        options.processGroupId,
      );

      // Only end the processing group if we created it and we have a valid outputProcessGroupId
      if (!options.processGroupId && outputProcessGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'error');
      }

      throw err; // Re-throw to maintain error propagation
    }
  }
}
