import * as path from 'path';

import type { IModelHandler } from '@agent/modelHandlers';
import { parseFilenameParts } from '@agent/utils';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentPrompt } from '@agent/core/AgentDataclass';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentFileLocation } from '@utils/files';

import { BaseReflectionAgent } from './BaseReflectionAgent';

/**
 * Specialized agent for merging multiple edited files into a consolidated output.
 * Handles complex filename parsing and maintains file relationships during merging.
 *
 * Note: MergeAgent uses `agentType: 'direct'` in its YAML configuration, which
 * provides single-round execution and scratchpad-only XML structure (via
 * BaseReflectionAgent's config-driven behavior).
 */
export class MergeAgent extends BaseReflectionAgent {
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
   * @returns Path to output file for merged content - always workspace or runStorage
   * @throws Error if editedFile is not specified
   */
  public override getOutputFileLocation(_currRound: number): AgentFileLocation {
    const inputFile = this.agentConfig.inputFile;
    const editedFile = this.agentConfig.editedFile;

    if (!editedFile) {
      throw new Error('editedFile must be specified for merge handler');
    }

    const inputDir = path.dirname(inputFile);
    const inputBase = path.parse(inputFile).name;
    const editedBase = path.parse(editedFile).name;

    const { base, agent, roundNum, model } = parseFilenameParts(editedBase);
    const finalBase = inputBase !== base ? inputBase : base;
    const outputFile = `${finalBase}_${agent}_r${roundNum}_full_${model}.tex`;
    const outputPath = path.join(inputDir, outputFile);

    return this.fileService.createLocation(outputPath) as AgentFileLocation;
  }
}
