// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { DirectAgent } from './DirectAgent';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ModelHandler } from './ModelHandler';
import { AgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt } from './AgentDataclass';

const CHANNEL = 'MergeAgent';
logger.initializeLogging(CHANNEL);

/**
 * Agent for merging multiple edited files into a single output.
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
   * Parse filename parts to extract base name, agent, round number and model.
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
    const model = parts[parts.length - 1];

    return [base, agent, roundNum, model];
  }

  /**
   * Generate output filename for merged content.
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
    logger.info(CHANNEL, `Merge output file: ${outputPath}`);
    return outputPath;
  }

  /**
   * Extract agent name from filename parts.
   * Handles two formats:
   * - Standard: base_agent_r1_model
   * - Complex: MutualInfo_restructured_polish_r1_sonnet++
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
   * Process and handle output files for the current round.
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
  ): Promise<string[]> {
    if (endTurn) {
      const files = await super.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
      );
      logger.info(CHANNEL, `Output file: ${outputFile}`);
      return files;
    }
    return [];
  }
}
