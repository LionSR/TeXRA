import * as path from 'node:path';

import { WORKFLOW_OUTPUT_BASENAME } from '@shared/constants/workflowOutput';
import { normalizeFilePath } from '@utils/core';

function getSafeDocumentPathParts(source: string): {
  dir: string;
  name: string;
  ext: string;
} {
  const sourcePath = normalizeFilePath(source);
  const parsed = path.posix.parse(sourcePath);
  const isAbsoluteSource =
    path.posix.isAbsolute(sourcePath) || /^[A-Za-z]:\//.test(sourcePath);
  const dir = isAbsoluteSource
    ? ''
    : parsed.dir
        .split('/')
        .filter(
          (seg) =>
            seg && seg !== '..' && seg !== '.' && !/^[A-Za-z]:$/.test(seg),
        )
        .join('/');

  return {
    dir,
    // `parsed.name` never contains a separator (parse already stripped it).
    name: parsed.name || 'extracted',
    ext: parsed.ext || '.tex',
  };
}

/**
 * Convert a model-produced document name to a portable relative path.
 *
 * Relative document names may intentionally carry subdirectories
 * (`chapters/main.tex`). Absolute document names are host paths, not workflow
 * names, so keep only their basename. In both cases strip traversal segments
 * so copied or extracted outputs remain inside the caller-chosen root.
 */
export function getSafeDocumentRelativePath(source: string): string {
  const safe = getSafeDocumentPathParts(source);
  // `safe.dir` is already forward-slash separated and separator-free names
  // make posix.join portable regardless of host platform (these are workflow
  // names, not host paths).
  return path.posix.join(safe.dir, `${safe.name}${safe.ext}`);
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
  const safe = getSafeDocumentPathParts(source);
  // Avoid the fallback `output` because the primary round output is already
  // `r{round}/output.{ext}`; a collision would overwrite it.
  // Guard against an LLM-supplied source like `output.tex` landing directly
  // in roundDir and overwriting the primary output.
  const safeName =
    safe.dir === '' && safe.name === WORKFLOW_OUTPUT_BASENAME
      ? `${WORKFLOW_OUTPUT_BASENAME}_extracted`
      : safe.name;
  return path.posix.join(roundDir, safe.dir, `${safeName}${safe.ext}`);
}
