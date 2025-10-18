// Node.js built-in modules
import * as path from 'path';

// Local imports - agent components
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
import { BaseReflectionAgent, RoundOutputOptions } from './BaseReflectionAgent';
import { getOutputFileName } from '@agent/output';

// Local imports - filesystem
import { getRunDir, isValidExecutionId } from '@utils/files/taskRunStorage';

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
    const outputFileName = getOutputFileName(
      baseOutputFile,
      this.agentConfig.agent,
      this.modelHandler.config.name,
      fileExtension,
      currRound,
      this.agentConfig.editedFile || undefined,
    );

    if (this.useScratchpad && isValidExecutionId(this.executionId)) {
      const baseName = path.basename(outputFileName);
      return path.join(getRunDir(this.executionId), baseName);
    }

    return outputFileName;
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
    // Declare the process group ID at the function scope level
    // Initialize with processGroupId if provided, otherwise it will be set in the try block
    let outputProcessGroupId: string = processGroupId || '';

    try {
      // Start a main output processing group if none provided
      if (!processGroupId) {
        outputProcessGroupId = await this.logger.startGroup(
          `OutputProcessing-Round${currRound}`,
          undefined,
          this.logger.getActiveGroupId(),
        );
      }

      // Initialize output files array if needed
      this.outputHandler.ensureRound(currRound);

      if (endTurn) {
        this.logger.debug(
          `Processing output for round ${currRound}`,
          outputProcessGroupId,
        );

        // First fix XML structure
        await this.outputHandler.xmlManager.ensureCorrectXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );

        // Then process output files using the output handler
        await this.outputHandler.processOutputFiles(
          outputFile,
          currRound,
          outputProcessGroupId,
        );

        // Note: latexdiff processing is now handled in the parent class's handleOutput method
      }

      // Finally handle statistics in base class (but pass our group ID)
      const result = await super.handleOutput(
        currRound,
        stateRound,
        stateGlobal,
        {
          outputFile,
          endTurn,
          processGroupId: outputProcessGroupId,
        },
      );

      // Only end the processing group if we created it
      // Maybe this kind of setup is more graceful to do a withGroup kind of function?
      if (!processGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'stopped');
      }

      return result;
    } catch (err) {
      this.logger.error(
        `Error in handleOutput for round ${currRound}: ${err}`,
        processGroupId,
      );

      // Only end the processing group if we created it and we have a valid outputProcessGroupId
      if (!processGroupId && outputProcessGroupId) {
        this.logger.endGroup(outputProcessGroupId, 'error');
      }

      throw err; // Re-throw to maintain error propagation
    }
  }
}
