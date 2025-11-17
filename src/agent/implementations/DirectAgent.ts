// Local imports - agent
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';

// Local imports - agent components
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';

/**
 * Direct agent implementation that processes requests in a single pass.
 * Extends BaseReflectionAgent with simplified output handling and no intermediate steps.
 */
export class DirectAgent extends BaseReflectionAgent {
  protected override getTotalRounds(): number {
    return 1;
  }

  /**
   * Processes output for the current round with minimal processing.
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    currRound: number,
    stateRound: ConversationRoundState,
    stateGlobal: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<string[]> {
    const { outputFile, endTurn, stage } = options;
    try {
      this.outputHandler.ensureRound(currRound);

      if (endTurn) {
        this.logger.debug(`Processing output for round ${currRound}`);

        if (this.useScratchpad) {
          const xmlResult =
            await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
              outputFile,
              this.agentSetting.documentTag,
            );
          if (xmlResult.fixed) {
            this.logger.debug(
              `XML structure was auto-fixed: ${xmlResult.reason}`,
            );
          }
        }

        await this.outputHandler.processOutputFiles(
          outputFile,
          currRound,
          stage,
        );
        this.logger.debug(`Output files processed for round ${currRound}`);
      }

      return super.handleOutput(currRound, stateRound, stateGlobal, options);
    } catch (error) {
      this.logger.error(`Error in DirectAgent.handleOutput: ${error}`);
      throw error;
    }
  }
}
