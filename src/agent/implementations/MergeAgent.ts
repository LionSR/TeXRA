// Standard library imports
import * as path from 'path';

// Local imports - agent
import type { IModelHandler } from '@agent/modelHandlers';
// Internal imports
import { parseFilenameParts } from '@agent/utils';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentPrompt } from '@agent/core/AgentDataclass';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import type { OutputFileInfo } from '@agent/output/types';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { WorkspaceFS } from '@utils/files';
import type { FileLocation, AgentFileLocation } from '@utils/files';

// Local file imports
import { RoundOutputOptions } from './BaseReflectionAgent';
import { DirectAgent } from './DirectAgent';

/**
 * Specialized agent for merging multiple edited files into a consolidated output.
 * Handles complex filename parsing and maintains file relationships during merging.
 */
export class MergeAgent extends DirectAgent {
  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    context: AgentExecutionContext,
  ) {
    super(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      context,
    );
    this.outputFile = [
      this.getOutputFileLocation(0),
      this.getOutputFileLocation(1),
    ];
  }

  /**
   * Generates output filename for merged content based on input and edited files.
   * @param currRound Current round number (unused in merge operations)
   * @returns Path to output file for merged content - always workspace or runStorage
   * @throws Error if editedFile is not specified
   */
  protected override getOutputFileLocation(
    currRound: number,
  ): AgentFileLocation {
    const inputFile = this.agentConfig.inputFile;
    const editedFile = this.agentConfig.editedFile;

    if (!editedFile) {
      throw new Error('editedFile must be specified for merge handler');
    }

    const inputDir = path.dirname(inputFile);
    const inputBase = path.parse(inputFile).name;
    const editedBase = path.parse(editedFile).name;

    // Parse filename components
    const { base, agent, roundNum, model } = parseFilenameParts(editedBase);

    // Use original input base if it differs from edited base
    const finalBase = inputBase !== base ? inputBase : base;

    // Construct output filename
    const outputFile = `${finalBase}_${agent}_r${roundNum}_full_${model}.tex`;
    const outputPath = path.join(inputDir, outputFile);

    // fileService.createLocation always returns workspace or runStorage for agent outputs
    return this.fileService.createLocation(outputPath) as AgentFileLocation;
  }

  /**
   * Processes output files for merge operation.
   * @param currRound Current round number (defaults to 0)
   * @param stateRound Current round state
   * @param stateGlobal Global conversation state
   * @param options Output processing options
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    currRound: number,
    stateRound: ConversationRoundState,
    stateGlobal: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<OutputFileInfo[]> {
    const { outputFile, endTurn } = options;
    if (endTurn) {
      this.logger.debug(`Processing merge output for round ${currRound}`);
      const files = await super.handleOutput(
        currRound,
        stateRound,
        stateGlobal,
        options,
      );
      this.logger.info(`Merge output file: ${outputFile}`);
      return files;
    }
    return [];
  }
}
