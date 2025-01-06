// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { DirectAgent } from './DirectAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';

/**
 * Chain of Thought (CoT) agent implementation that extends DirectAgent.
 * Adds XML structure validation and specialized output handling for multi-step reasoning.
 */
export class CoTAgent extends DirectAgent {
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
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
  ): Promise<string[]> {
    if (endTurn) {
      await this.outputHandler.ensureCorrectXmlStructure(
        outputFile,
        this.agentSetting.documentTag,
      );
      await this.processOutputFiles(outputFile, currRound);
    }
    return super.handleOutput(
      stateRound,
      stateGlobal,
      outputFile,
      endTurn,
      currRound,
    );
  }
}
