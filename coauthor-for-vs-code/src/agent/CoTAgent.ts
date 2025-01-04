// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { DirectAgent } from './DirectAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { getOutputFileName } from './OutputHandler';

/**
 * Chain of Thought agent implementation.
 */
export class CoTAgent extends DirectAgent {
  /**
   * Get the output file name for the given round.
   */
  protected getOutputFile(currRound: number): string {
    const baseOutputFile =
      this.agentConfig.outputNameOverride || this.agentConfig.inputFile;
    const fileExtension = this.useScratchpad
      ? 'xml'
      : this.agentSettings.outputExt;
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
      await this.outputHandler.ensureCorrectXmlStructure(
        outputFile,
        this.agentSettings.documentTag,
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
