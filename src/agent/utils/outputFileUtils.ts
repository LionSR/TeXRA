import * as path from 'path';

import type { TaskRunFileService, AgentFileLocation } from '@utils/files';
import { parseFilenameParts } from './mergeFileUtils';

/**
 * Generates an output path under a round subfolder, preserving the input
 * file's basename so downstream basename-based mapping (follow-up setup,
 * merge) continues to match outputs to their originals:
 *
 *   `<inputDir>/r{round}/<inputName>.{ext}`
 *
 * Workflow agent outputs always go to task run storage, which provides
 * execution context. Round subfolders group all artifacts from a single round.
 */
export function getOutputFileName(
  inputFile: string,
  outputExt: string,
  round: number,
): string {
  const parsed = path.parse(inputFile);
  return path.join(parsed.dir, `r${round}`, `${parsed.name}.${outputExt}`);
}

/**
 * Generates an output path for an extracted document from multi-document XML
 * output. The extracted doc is placed under the round directory, preserving
 * any subdirectory in the source path (e.g. `chapters/main.tex` and
 * `appendix/main.tex` produce distinct files under the same round dir).
 *
 * @param source Source document name from XML (e.g. "chapters/main.tex")
 * @param roundDir The round directory (already includes `r{round}`)
 */
export function getExtractedDocOutputFileName(
  source: string,
  roundDir: string,
): string {
  const parsed = path.parse(source);
  const extension = parsed.ext.replace('.', '') || 'tex';
  return path.join(roundDir, parsed.dir, `${parsed.name}.${extension}`);
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
