import * as path from 'path';

import { getCleanAgentName } from '@agent/index';
import type { TaskRunFileService, AgentFileLocation } from '@utils/files';

/**
 * Generates an output path under a round subfolder. The filename preserves
 * the input's basename plus agent and model tokens so different tabs that
 * process the same input (different agent or model) don't clobber each
 * other when writing to workspace storage, and so downstream
 * basename-containment mapping (follow-up setup, merge) still resolves
 * outputs back to their originals:
 *
 *   `<inputDir>/r{round}/<inputName>_<agent>_<model>.{ext}`
 *
 * The round subfolder groups all artifacts from a single round. Source
 * prefixes (`builtin:polish`) are stripped from the agent token.
 */
export function getOutputFileName(
  inputFile: string,
  agent: string,
  model: string,
  outputExt: string,
  round: number,
): string {
  const parsed = path.parse(inputFile);
  const cleanAgent = getCleanAgentName(agent);
  return path.join(
    parsed.dir,
    `r${round}`,
    `${parsed.name}_${cleanAgent}_${model}.${outputExt}`,
  );
}

/**
 * Generates an output path for an extracted document from multi-document XML
 * output. The extracted doc is placed under the round directory, preserving
 * any subdirectory in the source path (e.g. `chapters/main.tex` and
 * `appendix/main.tex` produce distinct files under the same round dir).
 *
 * Like the primary output filename, the extracted filename includes agent
 * and model tokens so two tabs on the same input (different agent/model)
 * don't collide on extracted-doc paths in workspace storage mode.
 *
 * Guards against path traversal: absolute paths, drive letters, and `..`
 * segments in the model-produced `source` are stripped so the output
 * always lands inside `roundDir`.
 *
 * @param source Source document name from XML (e.g. "chapters/main.tex")
 * @param roundDir The round directory (already includes `r{round}`)
 * @param agent Clean agent identifier (source prefixes stripped)
 * @param model Model name (dots preserved)
 */
export function getExtractedDocOutputFileName(
  source: string,
  roundDir: string,
  agent: string,
  model: string,
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
  const cleanAgent = getCleanAgentName(agent);
  return path.join(
    roundDir,
    safeDir,
    `${safeName}_${cleanAgent}_${model}.${extension}`,
  );
}

/**
 * Creates a merge-specific output file location getter.
 *
 * Merge is a single-output workflow: the round number is not reflected in
 * the filename and the same location is returned for every round. The
 * output lives next to the input file with a `_full_<model>` suffix so
 * consecutive merges with different models don't clobber each other and
 * existing housekeeping cleanup (which matches on the model token) still
 * discovers the artifact.
 *
 * @param inputFile Original input file path
 * @param model Model used for the merge (discriminator to avoid collisions)
 * @param fileService File service for creating locations
 */
export function createMergeOutputFileLocationGetter(
  inputFile: string,
  model: string,
  fileService: TaskRunFileService,
): (round: number) => AgentFileLocation {
  const inputDir = path.dirname(inputFile);
  const inputBase = path.parse(inputFile).name;
  const outputPath = path.join(inputDir, `${inputBase}_full_${model}.tex`);

  // Pre-compute location (merge is single-output, always the same location)
  const location = fileService.createLocation(outputPath) as AgentFileLocation;
  return (_round: number): AgentFileLocation => location;
}
