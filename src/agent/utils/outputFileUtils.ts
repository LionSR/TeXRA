import * as path from 'path';

import {
  WORKFLOW_DOCUMENT_OUTPUT_EXT,
  WORKFLOW_OUTPUT_BASENAME,
  workflowMergeOutputPath,
  workflowOutputPath,
} from '@agent/output/workflowOutputLayout';
import type { TaskRunFileService, AgentFileLocation } from '@utils/files';

/**
 * Generates a runDir-relative output path under a round subfolder:
 *
 *   `r{round}/output.{ext}`
 *
 * Per-execution isolation (`executions/{id}/...`) gives each run its own
 * directory, so no agent/model/input tokens are needed in the filename.
 *
 * IMPORTANT: callers MUST resolve this through a TaskRunFileService bound
 * to an executionId. The fixed-stem filename is only collision-safe when
 * combined with per-execution run storage; a workspace-scoped resolution
 * would route every round to the same `<workspace>/r{round}/output.{ext}`
 * and clobber outputs across runs.
 */
export function getOutputFileName(extension: string, round: number): string {
  return workflowOutputPath({ ext: extension, round });
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
  const sourcePath = source.replaceAll('\\', '/');
  const parsed = path.posix.parse(sourcePath);
  const isAbsoluteSource =
    path.posix.isAbsolute(sourcePath) || /^[A-Za-z]:\//.test(sourcePath);
  const extension = parsed.ext.replace('.', '') || 'tex';
  // Relative document names may intentionally carry subdirectories
  // (`chapters/main.tex`). Absolute document names are host paths, not workflow
  // names, so keep only their basename. In both cases strip traversal segments
  // so the output remains inside roundDir.
  const safeDir = isAbsoluteSource
    ? ''
    : parsed.dir
        .split('/')
        .filter(
          (seg) =>
            seg && seg !== '..' && seg !== '.' && !/^[A-Za-z]:$/.test(seg),
        )
        .join(path.sep);
  // Avoid the fallback `output` because the primary round output is already
  // `r{round}/output.{ext}`; a collision would overwrite it.
  const rawName = path.basename(parsed.name) || 'extracted';
  // Guard against an LLM-supplied source like `output.tex` landing directly
  // in roundDir and overwriting the primary output.
  const safeName =
    safeDir === '' && rawName === WORKFLOW_OUTPUT_BASENAME
      ? `${WORKFLOW_OUTPUT_BASENAME}_extracted`
      : rawName;
  return path.join(roundDir, safeDir, `${safeName}.${extension}`);
}

/**
 * Creates a merge-specific output file location getter.
 *
 * Merge is a single-output workflow: the round number is not reflected in
 * the filename and the same location is returned for every round. The
 * merge output lives at the runDir root as `_full.tex`; per-execution
 * isolation keeps it from colliding with other runs.
 *
 * The fileService MUST carry an executionId; the fixed `_full.tex` path
 * relies on run-storage isolation for uniqueness. Without it, every merge
 * in the workspace would clobber the same file.
 *
 * Merge is always a LaTeX workflow, so the output extension is fixed rather
 * than configurable through agent YAML.
 */
export function createMergeOutputFileLocationGetter(
  fileService: TaskRunFileService,
): (round: number) => AgentFileLocation {
  if (!fileService.hasRunDirectory()) {
    throw new Error(
      'createMergeOutputFileLocationGetter requires a TaskRunFileService bound to an executionId; the `_full.tex` path is only collision-safe inside per-execution run storage.',
    );
  }
  const outputPath = workflowMergeOutputPath({
    ext: WORKFLOW_DOCUMENT_OUTPUT_EXT,
  });
  const location = fileService.createLocation(outputPath) as AgentFileLocation;
  return (_round: number): AgentFileLocation => location;
}
