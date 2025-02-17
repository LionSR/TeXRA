// Standard library imports
import * as path from 'path';

// Local imports - agent components
import { DirectAgent } from './DirectAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ModelHandler } from './ModelHandler';
import { AgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt } from './AgentDataclass';

/**
 * Specialized agent for merging multiple edited files into a consolidated output.
 * Handles complex filename parsing and maintains file relationships during merging.
 */
export class MergeAgent extends DirectAgent {
  constructor(
    modelHandler: ModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    super(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath);
    this.outputFile = [this.getOutputFile(0), this.getOutputFile(1)];
  }

  /**
   * Extracts components from edited filename for merge operations.
   * @param editedBase Base name of edited file without extension
   * @returns Tuple of [base name, agent name, round number, model name]
   * @throws Error if filename components cannot be extracted
   */
  private parseFilenameParts(
    editedBase: string,
  ): [string, string, number, string] {
    const parts = editedBase.split('_');
    const underscoreCount = editedBase.split('_').length - 1;
    const base = parts[0];

    // Extract agent name
    const agent = this.extractAgentName(parts, underscoreCount);
    if (!agent) {
      throw new Error(
        `Could not extract agent name from edited base: ${editedBase}`,
      );
    }

    // Extract round number
    const roundMatch = editedBase.match(/_r(\d+)_/);
    if (!roundMatch) {
      throw new Error(
        `Could not extract round number from edited base: ${editedBase}`,
      );
    }
    const roundNum = parseInt(roundMatch[1], 10);

    // Get model name (last part)
    const model = parts.at(-1) || '';

    return [base, agent, roundNum, model];
  }

  /**
   * Generates output filename for merged content based on input and edited files.
   * @param currRound Current round number (unused in merge operations)
   * @returns Path to output file for merged content
   * @throws Error if editedFile is not specified
   */
  protected getOutputFile(currRound: number): string {
    const inputFile = this.agentConfig.inputFile;
    const editedFile = this.agentConfig.editedFile;

    if (!editedFile) {
      throw new Error('editedFile must be specified for merge handler');
    }

    const inputDir = path.dirname(inputFile);
    const inputBase = path.parse(inputFile).name;
    const editedBase = path.parse(editedFile).name;

    // Parse filename components
    const [base, agent, roundNum, model] = this.parseFilenameParts(editedBase);

    // Use original input base if it differs from edited base
    const finalBase = inputBase !== base ? inputBase : base;

    // Construct output filename
    const outputFile = `${finalBase}_${agent}_r${roundNum}_full_${model}.tex`;
    const outputPath = path.join(inputDir, outputFile);
    return outputPath;
  }

  /**
   * Extracts agent name from filename parts handling multiple formats.
   * @param parts Array of filename parts split by underscore
   * @param underscoreCount Total number of underscores in filename
   * @returns Agent name or null if not found
   */
  private extractAgentName(
    parts: string[],
    underscoreCount: number,
  ): string | null {
    if (underscoreCount === 3) {
      // Standard format
      return parts[1];
    }

    // Complex format - collect parts until round number
    const agentParts: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('r') && /^\d+$/.test(part.slice(1))) {
        return agentParts.join('_');
      }
      agentParts.push(part);
    }
    return null;
  }

  /**
   * Processes output files for merge operation.
   * @param stateRound Current round state
   * @param stateGlobal Global conversation state
   * @param outputFile Path to the output file
   * @param endTurn Whether this is the end of the current turn
   * @param currRound Current round number (defaults to 0)
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
      this.logger.debug(`Processing merge output for round ${currRound}`);
      const files = await super.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
      );
      this.logger.info(`Merge output file: ${outputFile}`);
      return files;
    }
    return [];
  }
}
