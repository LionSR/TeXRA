import * as path from 'path';

import type { TaskRunFileService, AgentFileLocation } from '@utils/files';

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
 * Guards against path traversal: absolute paths and `..` segments in the
 * model-produced `source` are stripped so the output always lands inside
 * `roundDir`.
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
  // Strip absolute prefixes, drive-letter segments, and traversal segments
  // so a malicious or malformed source cannot escape roundDir via
  // path.join's absolute-override or parent-directory semantics.
  const safeDir = parsed.dir
    .split(/[\\/]+/)
    .filter(
      (seg) => seg && seg !== '..' && seg !== '.' && !/^[A-Za-z]:$/.test(seg),
    )
    .join(path.sep);
  const safeName = path.basename(parsed.name) || 'output';
  return path.join(roundDir, safeDir, `${safeName}.${extension}`);
}

/**
 * Creates a merge-specific output file location getter.
 *
 * Merge is a single-output workflow: the round number is not reflected in
 * the filename and the same location is returned for every round. The
 * output lives next to the input file with a `_full` suffix, matching the
 * convention the user already sees for merged documents.
 *
 * @param inputFile Original input file path
 * @param editedFile The edited file being merged (required for merge operations)
 * @param fileService File service for creating locations
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
  const outputPath = path.join(inputDir, `${inputBase}_full.tex`);

  // Pre-compute location (merge is single-output, always the same location)
  const location = fileService.createLocation(outputPath) as AgentFileLocation;
  return (_round: number): AgentFileLocation => location;
}
