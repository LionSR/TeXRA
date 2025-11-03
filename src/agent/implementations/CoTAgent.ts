// Local imports - agent components
import { ConversationRoundState, AgentRunState } from '../core/AgentState';
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';
import { getOutputFileName } from '@agent/output';

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
    currRound: number,
    stateRound: ConversationRoundState,
    stateGlobal: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<string[]> {
    const { outputFile, endTurn } = options;

    try {
      this.outputHandler.ensureRound(currRound);

      if (endTurn) {
        this.logger.debug(`Processing output for round ${currRound}`);

        await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );

        await this.outputHandler.processOutputFiles(outputFile, currRound);
      }

      return super.handleOutput(currRound, stateRound, stateGlobal, {
        outputFile,
        endTurn,
      });
    } catch (error) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${error}`,
      );
      throw error;
    }
  }
}
