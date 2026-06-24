/**
 * Extract file dependencies from LaTeX content.
 *
 * Parses \input{}, \include{}, \bibliography{}, and \addbibresource{}
 * commands to discover files that the main document depends on.
 * Used by LatexMediaManager to mirror these dependencies into run storage
 * so that output files can be compiled outside the workspace.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import pMap from 'p-map';

// Local imports
import { platform } from '@platform/platform';
import type { FileLocation } from '@shared/schemas';
import { flexibleFS } from '@utils/files';
import { ensureExtension, joinLatexPath } from '@utils/core/pathCore';

// Local file imports
import {
  collectBibliographyPaths,
  existingExternalPath,
  stripLatexComments,
} from './latexParsingUtils';

const INPUT_PATTERN = /\\input\s*\{([^}]+)\}/g;
const INCLUDE_PATTERN = /\\include\s*\{([^}]+)\}/g;

/**
 * Resolve a TeX input path (\input / \include argument) to an existing
 * absolute path. Tries the literal path first, then with `.tex` appended
 * (case-insensitive — `chapter.TEX` is not double-extended). Returns null
 * for empty/whitespace input or when neither candidate exists.
 *
 * Uses `joinLatexPath` (not `path.join`) so leading slashes in TeX paths
 * are stripped and absolute paths are preserved, matching LaTeX's own
 * `\input` resolution.
 */
async function resolveTexInputPath(
  rawPath: string,
  baseDir: string,
): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const absolute = joinLatexPath(baseDir, trimmed);
  const hit = await existingExternalPath(absolute);
  if (hit) return hit;

  const withExt = ensureExtension(absolute, '.tex');
  if (withExt === absolute) return null;
  return existingExternalPath(withExt);
}

/**
 * Extract file dependencies (\input, \include, \bibliography, \addbibresource)
 * from a LaTeX file. Returns absolute paths to existing files.
 *
 * Uses the platform realpath operation to follow symlinks so that when the input file lives in
 * run storage (as a symlink to the workspace), dependencies are resolved
 * relative to the original workspace location where they actually exist.
 */
export async function extractLatexFileDependencies(
  latexFileLocation: FileLocation,
): Promise<string[]> {
  // Follow symlinks so run-storage paths resolve against the workspace
  const realPath = await platform().fs.realPath(latexFileLocation.absolutePath);
  const latexDir = path.dirname(realPath);

  const content = await flexibleFS.read(latexFileLocation);
  const uncommented = stripLatexComments(content);

  const texInputPaths: string[] = [];
  for (const pattern of [INPUT_PATTERN, INCLUDE_PATTERN]) {
    for (const match of uncommented.matchAll(pattern)) {
      texInputPaths.push(match[1]);
    }
  }

  const bibCandidates = collectBibliographyPaths(latexDir, uncommented);

  const [texResolved, bibResolved] = await Promise.all([
    pMap(texInputPaths, (raw) => resolveTexInputPath(raw, latexDir), {
      concurrency: 8,
    }),
    pMap(bibCandidates, (absolute) => existingExternalPath(absolute), {
      concurrency: 8,
    }),
  ]);

  const results = new Set<string>();
  for (const resolved of [...texResolved, ...bibResolved]) {
    if (resolved) results.add(resolved);
  }

  return [...results];
}
