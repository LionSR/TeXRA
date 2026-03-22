import * as path from 'path';

import type { TaskRunFileService, AgentFileLocation } from '@utils/files';
import { parseFilenameParts } from './mergeFileUtils';

/**
 * Generates an output filename: `output_r{round}.{ext}`.
 *
 * Workflow agent outputs always go to task run storage, which already provides
 * context (execution ID, agent, model). The filename only needs the round number.
 *
 * @param outputExt Extension for the output file
 * @param round Current round number
 * @param inputFile The input file path (used only for directory resolution)
 * @param options Optional output directory override
 */
export function getOutputFileName(
  outputExt: string,
  round: number,
  inputFile: string,
  options?: {
    outputDir?: string;
  },
): string {
  const { dir } = path.parse(inputFile);
  const targetDir = options?.outputDir ?? dir;
  return path.join(targetDir, `output_r${round}.${outputExt}`);
}

/**
 * Generates an output filename for an extracted document from multi-document XML output:
 * `{sourceName}_r{round}.{ext}`.
 *
 * Uses the source document name to differentiate multiple extracted files within
 * the same round. Like {@link getOutputFileName}, omits agent/model since outputs
 * live in task run storage.
 *
 * @param source Source document name (from XML content, e.g. "chapter1.tex")
 * @param round Current round number
 * @param outputDir Directory to place the file in
 */
export function getExtractedDocOutputFileName(
  source: string,
  round: number,
  outputDir: string,
): string {
  const { name: sourceName, ext } = path.parse(source);
  const extension = ext.replace('.', '') || 'tex';
  return path.join(outputDir, `${sourceName}_r${round}.${extension}`);
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

  // Pre-compute location (merge is single-output, always the same location)
  const location = fileService.createLocation(outputPath) as AgentFileLocation;
  return (_round: number): AgentFileLocation => location;
}
