// Local imports - agent
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import type { OutputFileInfo } from '@agent/output/types';

// Local imports - agent components
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';

/**
 * Direct agent implementation that processes requests in a single pass.
 * Extends BaseReflectionAgent with simplified output handling and no intermediate steps.
 *
 * Uses the pocketflow-based output processing flow for cleaner separation of concerns.
 * XML validation is only performed when scratchpad is used (inherited from BaseReflectionAgent).
 */
export class DirectAgent extends BaseReflectionAgent {
  protected override getTotalRounds(): number {
    return 1;
  }

  /**
   * Processes output for the current round using the pocketflow-based processing flow.
   * XML validation is only performed when scratchpad is used.
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
        // shouldValidateXml() returns this.useScratchpad by default
        await this.processOutputWithFlow(currRound, outputFile, endTurn, stage);
        this.logger.debug(`Output files processed for round ${currRound}`);
      }

      // Call base for latexdiff handling
      return super.handleOutput(currRound, stateRound, stateGlobal, options);
    } catch (error) {
      this.logger.error(`Error in DirectAgent.handleOutput: ${error}`);
      throw error;
    }
  }
}
