// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { BaseReflectionAgent } from './BaseReflectionAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';

/**
 * Direct agent implementation of BaseReflectionAgent.
 */
export class DirectAgent extends BaseReflectionAgent {
  /**
   * Get the output file name for the given round.
   */
  protected getOutputFile(currRound: number): string {
    const baseOutputFile =
      this.agentConfig.outputNameOverride || this.agentConfig.inputFile;
    return getOutputFileName(
      baseOutputFile,
      this.agentConfig.agent,
      this.modelHandler.config.name,
      this.agentSettings.outputExt,
      currRound,
      this.agentConfig.editedFile || undefined,
    );
  }

  /**
   * Handle the output for the given round.
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
  ): Promise<string[]> {
    if (endTurn) {
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
