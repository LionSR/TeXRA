// Standard library imports
import * as path from 'path';

// Local imports
import { getAgentFirstNameChunk } from '@housekeeping/utils';
import { parseFilenameParts } from './mergeFileUtils';
import type { TaskRunFileService, AgentFileLocation } from '@utils/files';

/**
 * Generates an output filename incorporating model and round information.
 *
 * @param inputFile The input file path
 * @param agent Agent name (may include source: prefix which will be stripped)
 * @param model Model name
 * @param outputExt Extension for the output file
 * @param currRound Current round number
 * @param editedFile Optional previously edited file for round detection
 */
export function getOutputFileName(
  inputFile: string,
  agent: string,
  model: string,
  outputExt: string,
  currRound: number,
  editedFile?: string,
  options?: {
    outputDir?: string;
  },
): string {
  const { dir, name: fileName } = path.parse(inputFile);
  // Extract agent first name chunk (handles source: prefix and write- agents)
  const agentFirstNameChunk = getAgentFirstNameChunk(agent);

  let newRound = currRound;
  if (editedFile) {
    const match = editedFile.match(/_r(\d+)_/);
    const editedRound = match ? parseInt(match[1]) : 0;
    newRound += editedRound + 1;
  }

  const outputBaseName = `${fileName}_${agentFirstNameChunk}_r${newRound}_${model}.${outputExt}`;
  const targetDir = options?.outputDir ?? dir;
  return path.join(targetDir, outputBaseName);
}

/**
 * Creates a merge-specific output file location getter.
 *
 * Merge operations use specialized naming: `{base}_{agent}_r{round}_full_{model}.tex`
 * This extracts agent/round/model from the edited file name and creates a "full" merged output.
 *
 * @param inputFile Original input file path
 * @param editedFile The edited file being merged (required for merge operations)
 * @param fileService File service for creating locations
 * @returns A function that generates output file locations for each round
 * @throws Error if editedFile is not provided
 */
export function createMergeOutputFileLocationGetter(
  inputFile: string,
  editedFile: string | undefined,
  fileService: TaskRunFileService,
): (round: number) => AgentFileLocation {
  if (!editedFile) {
    throw new Error('editedFile must be specified for merge handler');
  }

  const inputDir = path.dirname(inputFile);
  const inputBase = path.parse(inputFile).name;
  const editedBase = path.parse(editedFile).name;

  // Parse filename parts from edited file to preserve agent/round/model info
  const { base, agent, roundNum, model } = parseFilenameParts(editedBase);
  const finalBase = inputBase !== base ? inputBase : base;
  const outputFile = `${finalBase}_${agent}_r${roundNum}_full_${model}.tex`;
  const outputPath = path.join(inputDir, outputFile);

  // Return a getter that always returns the same location (merge is single-output)
  return (_round: number): AgentFileLocation => {
    return fileService.createLocation(outputPath) as AgentFileLocation;
  };
}
