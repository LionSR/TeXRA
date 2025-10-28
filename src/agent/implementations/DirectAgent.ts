// Local imports - agent
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
// Local imports - agent components
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';
import { getOutputFileName } from '@agent/output';

// Local imports - logging
import { withLogGroup } from '@logger/logGroupUtils';

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
    const { outputFile, endTurn } = options;

    return withLogGroup(
      this.logger,
      `OutputProcessing-Round${currRound}`,
      async () => {
        try {
          this.outputHandler.ensureRound(currRound);

          if (endTurn) {
            this.logger.debug(`Processing output for round ${currRound}`);

            if (this.useScratchpad) {
              await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
                outputFile,
                this.agentSetting.documentTag,
              );
            }

            await this.outputHandler.processOutputFiles(outputFile, currRound);
            this.logger.debug(`Output files processed for round ${currRound}`);
          }

          return super.handleOutput(currRound, stateRound, stateGlobal, {
            outputFile,
            endTurn,
          });
        } catch (error) {
          this.logger.error(`Error in DirectAgent.handleOutput: ${error}`);
          throw error;
        }
      },
      { parentGroupId: this.logger.getActiveGroupId() },
    );
  }
}
