// Local imports - agent components
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';
import { getOutputFileName } from '@agent/output';

// Local imports - logging
import { withLogGroup } from '@logger/logGroupUtils';

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
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ): Promise<string[]> {
    const { outputFile, endTurn, processGroupId } = options;

    const runOutputHandling = async (groupId?: string): Promise<string[]> => {
      const effectiveGroupId = groupId ?? this.logger.getActiveGroupId();

      try {
        this.outputHandler.ensureRound(currRound);

        if (endTurn) {
          this.logger.debug(
            `Processing output for round ${currRound}`,
            effectiveGroupId,
          );

          await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
            outputFile,
            this.agentSetting.documentTag,
          );

          await this.outputHandler.processOutputFiles(
            outputFile,
            currRound,
            effectiveGroupId,
          );
        }

        return super.handleOutput(currRound, stateRound, stateGlobal, {
          outputFile,
          endTurn,
          processGroupId: effectiveGroupId,
        });
      } catch (error) {
        this.logger.error(
          `Error in handleOutput for round ${currRound}: ${error}`,
          effectiveGroupId,
        );
        throw error;
      }
    };

    if (processGroupId) {
      return runOutputHandling(processGroupId);
    }

    return withLogGroup(
      this.logger,
      `OutputProcessing-Round${currRound}`,
      runOutputHandling,
      { parentGroupId: this.logger.getActiveGroupId() },
    );
  }
}
