// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';
import { BaseReflectionAgent } from './BaseReflectionAgent';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

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
  ): Promise<string[]> {
    try {
      // Initialize output files array if needed
      this.outputHandler.outputFiles[currRound] =
        this.outputHandler.outputFiles[currRound] || [];

      if (endTurn) {
        logger.debug(CHANNEL, `Processing output for round ${currRound}`);

        // Process XML structure first
        await this.outputHandler.ensureCorrectXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );
        logger.debug(CHANNEL, `XML structure processed for round ${currRound}`);

        // Then process output files
        await this.processOutputFiles(outputFile, currRound);
        logger.debug(CHANNEL, `Output files processed for round ${currRound}`);
      }

      // Finally handle logging in base class
      const result = await super.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
      );

      return result;
    } catch (error) {
      logger.error(
        CHANNEL,
        `Error in handleOutput for round ${currRound}: ${error}`,
      );
      throw error; // Re-throw to maintain error propagation
    }
  }
}
