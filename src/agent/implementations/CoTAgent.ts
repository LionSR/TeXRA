// Local imports - agent components
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import type { OutputFileInfo } from '@agent/output/types';

// Local file imports
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';

/**
 * Chain of Thought (CoT) agent implementation that extends BaseReflectionAgent.
 * Adds XML structure validation and specialized output handling for multi-step reasoning.
 *
 * Uses the pocketflow-based output processing flow for cleaner separation of concerns.
 */
export class CoTAgent extends BaseReflectionAgent {
  /**
   * CoT agents always validate XML structure for proper document extraction.
   */
  protected override shouldValidateXml(): boolean {
    return true;
  }

  /**
   * Processes output for the current round using the pocketflow-based processing flow.
   * XML validation is always performed for CoT agents.
   *
   * @returns Array of processed output file paths
   */
  protected override async handleOutput(
    currRound: number,
    stateRound: ConversationRoundState,
    stateGlobal: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<OutputFileInfo[]> {
    const { outputFile, endTurn, stage } = options;

    try {
      if (endTurn) {
        this.logger.debug(`Processing output for round ${currRound}`);

        // Use pocketflow-based processing
        await this.processOutputWithFlow(currRound, outputFile, endTurn, stage);
      }

      // Call base for latexdiff handling
      return super.handleOutput(currRound, stateRound, stateGlobal, options);
    } catch (error) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${error}`,
      );
      throw error;
    }
  }
}
