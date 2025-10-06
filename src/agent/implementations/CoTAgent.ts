// Local imports - agent components
import { BaseReflectionAgent } from './BaseReflectionAgent';
import { getOutputFileName } from '@agent/output';

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

  protected async preprocessOutputForRound(
    _currRound: number,
    outputFile: string,
    _processGroupId: string,
  ): Promise<void> {
    await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
      outputFile,
      this.agentSetting.documentTag,
    );
  }
}
