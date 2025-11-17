// Local imports - agent components
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import type { OutputFileInfo } from '@agent/output/types';

// Local file imports
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';

/**
 * Chain of Thought (CoT) agent implementation that extends BaseReflectionAgent.
 * Adds XML structure validation and specialized output handling for multi-step reasoning.
 */
export class CoTAgent extends BaseReflectionAgent {
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
  ): Promise<OutputFileInfo[]> {
    const { outputFile, endTurn, stage } = options;

    try {
      this.outputHandler.ensureRound(currRound);

      if (endTurn) {
        this.logger.debug(`Processing output for round ${currRound}`);

        await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );

        await this.outputHandler.processOutputFiles(outputFile, currRound, stage);
      }

      return super.handleOutput(currRound, stateRound, stateGlobal, options);
    } catch (error) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${error}`,
      );
      throw error;
    }
  }
}
