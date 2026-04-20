import * as path from 'path';

import {
  workflowMergeOutputPath,
  workflowOutputPath,
  workflowOutputRoundDir,
} from '@agent/output/workflowOutputLayout';
import type { TaskRunFileService, AgentFileLocation } from '@utils/files';

/**
 * Generates a runDir-relative output path under a round subfolder:
 *
 *   `r{round}/output.{ext}`
 *
 * Per-execution isolation (`executions/{id}/...`) gives each run its own
 * directory, so no agent/model/input tokens are needed in the filename.
 */
export function getOutputFileName(outputExt: string, round: number): string {
  return workflowOutputPath({ ext: outputExt, round });
}

/**
 * Generates an output path for an extracted document from multi-document XML
 * output. The extracted doc is placed under the round directory, preserving
 * any subdirectory in the source path (e.g. `chapters/main.tex` and
 * `appendix/main.tex` produce distinct files under the same round dir).
 *
 * Guards against path traversal: absolute paths, drive letters, and `..`
 * segments in the model-produced `source` are stripped so the output
 * always lands inside `roundDir`.
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
 * merge output lives at the runDir root as `_full.{ext}`; per-execution
 * isolation keeps it from colliding with other runs.
 */
export function createMergeOutputFileLocationGetter(
  fileService: TaskRunFileService,
): (round: number) => AgentFileLocation {
  const outputPath = workflowMergeOutputPath({ ext: 'tex' });
  const location = fileService.createLocation(outputPath) as AgentFileLocation;
  return (_round: number): AgentFileLocation => location;
}

/** Re-export for callers building round-scoped glob prefixes. */
export { workflowOutputRoundDir };
