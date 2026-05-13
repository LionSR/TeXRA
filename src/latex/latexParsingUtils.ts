/**
 * Shared LaTeX content parsing utilities.
 *
 * Common patterns used by both extractBibliography.ts and
 * extractFileDependencies.ts for comment stripping and
 * bibliography directive matching.
 */

import * as path from 'path';
import { promises as fs } from 'fs';

import { flexibleFS } from '@utils/files';
import { ensureExtension, joinLatexPath } from '@utils/core/pathCore';

/** Strips everything after an unescaped % on each line. */
const COMMENT_PATTERN = /(^|[^\\])%.*$/gm;

export function stripLatexComments(content: string): string {
  return content.replaceAll(COMMENT_PATTERN, '$1');
}

/**
 * Matches both \bibliography{...} and \addbibresource[...]{...}.
 * matchAll clones the regex, so a single module-level instance is safe.
 */
const BIB_DIRECTIVE_PATTERN = new RegExp(
  '(?:bibliography|addbibresource)(?:\\s*\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}',
  'g',
);

/**
 * Directory containing a LaTeX file, following symlinks so references
 * inside a file mirrored into run storage resolve against the workspace.
 * Falls back to the literal dirname if the file can't be realpath'd.
 */
export async function resolveLatexDir(absolutePath: string): Promise<string> {
  const resolved = await fs.realpath(absolutePath).catch(() => absolutePath);
  return path.dirname(resolved);
}

/**
 * Return `absolutePath` if it exists on disk, otherwise null. Centralizes
 * the `flexibleFS.exists({ kind: 'external', ... })` boilerplate used by
 * the various LaTeX dependency resolvers.
 */
export async function existingExternalPath(
  absolutePath: string,
): Promise<string | null> {
  if (await flexibleFS.exists({ kind: 'external', absolutePath })) {
    return absolutePath;
  }
  return null;
}

/**
 * Search `searchPaths × extensions` for the first existing file and return
 * its normalized absolute path, or null if nothing exists.
 *
 * - `relativePath` is joined against each entry in `searchPaths`.
 * - Each `extensions` entry is appended to the joined path; pass `''` to test
 *   the path as-is.
 * - The search is ordered: outer loop over `searchPaths`, inner over
 *   `extensions`. The first hit wins.
 */
export async function findExistingLatexPath(
  relativePath: string,
  searchPaths: string[],
  extensions: string[],
): Promise<string | null> {
  for (const basePath of searchPaths) {
    const joined = path.normalize(path.join(basePath, relativePath));
    for (const ext of extensions) {
      const hit = await existingExternalPath(ext ? `${joined}${ext}` : joined);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Collect candidate `.bib` paths referenced by `\bibliography` and
 * `\addbibresource` directives in `content`, joined against `baseDir`.
 * Empty/whitespace entries are skipped and duplicates are de-duplicated.
 * Existence checking is the caller's responsibility.
 */
export function collectBibliographyPaths(
  baseDir: string,
  content: string,
): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(BIB_DIRECTIVE_PATTERN)) {
    for (const raw of match[1].split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      paths.add(joinLatexPath(baseDir, ensureExtension(trimmed, '.bib')));
    }
  }
  return [...paths];
}
