/**
 * Extract file dependencies from LaTeX content.
 *
 * Parses \input{}, \include{}, \bibliography{}, and \addbibresource{}
 * commands to discover files that the main document depends on.
 * Used by LatexMediaManager to mirror these dependencies into run storage
 * so that output files can be compiled outside the workspace.
 */

// Standard library imports
import * as path from 'path';

// Local imports
import { flexibleFS } from '@utils/files';
import type { FileLocation } from '@utils/files';
import { ensureExtension, joinLatexPath } from '@utils/core/pathCore';

const COMMENT_LINE = /^\s*%/;

function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const INPUT_PATTERN = /\\input\s*\{([^}]+)\}/g;
const INCLUDE_PATTERN = /\\include\s*\{([^}]+)\}/g;

/** Matches both \bibliography{...} and \addbibresource[...]{...}.
 *  Same pattern shape as extractBibliography.ts DIRECTIVE_PATTERN. */
const BIB_DIRECTIVE_PATTERN = new RegExp(
  '(?:bibliography|addbibresource)(?:\\s*\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}',
  'g',
);

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a TeX input path to an existing absolute path.
 * Checks as-is first, then with .tex appended.
 */
async function resolveTexInputPath(
  rawPath: string,
  baseDir: string,
): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const absolute = joinLatexPath(baseDir, trimmed);
  if (
    await flexibleFS.exists({ kind: 'external', absolutePath: absolute })
  ) {
    return absolute;
  }

  const withExt = ensureExtension(absolute, '.tex');
  if (
    withExt !== absolute &&
    (await flexibleFS.exists({ kind: 'external', absolutePath: withExt }))
  ) {
    return withExt;
  }

  return null;
}

/**
 * Resolve a bibliography path to an existing absolute path.
 */
async function resolveBibPath(
  rawPath: string,
  baseDir: string,
): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const absolute = joinLatexPath(baseDir, ensureExtension(trimmed, '.bib'));
  if (
    await flexibleFS.exists({ kind: 'external', absolutePath: absolute })
  ) {
    return absolute;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract file dependencies (\input, \include, \bibliography, \addbibresource)
 * from a LaTeX file. Returns absolute paths to existing files.
 */
export async function extractLatexFileDependencies(
  latexFileLocation: FileLocation,
): Promise<string[]> {
  const latexDir = path.dirname(latexFileLocation.absolutePath);
  const content = await flexibleFS.read(latexFileLocation);
  const uncommented = stripCommentLines(content);

  // Collect raw paths from all patterns
  const texInputPaths: string[] = [];
  for (const match of uncommented.matchAll(INPUT_PATTERN)) {
    texInputPaths.push(match[1]);
  }
  for (const match of uncommented.matchAll(INCLUDE_PATTERN)) {
    texInputPaths.push(match[1]);
  }

  const bibPaths: string[] = [];
  for (const match of uncommented.matchAll(BIB_DIRECTIVE_PATTERN)) {
    for (const entry of match[1].split(',')) {
      bibPaths.push(entry);
    }
  }

  // Resolve all paths in parallel
  const [texResolved, bibResolved] = await Promise.all([
    Promise.all(texInputPaths.map((raw) => resolveTexInputPath(raw, latexDir))),
    Promise.all(bibPaths.map((raw) => resolveBibPath(raw, latexDir))),
  ]);

  const results = new Set<string>();
  for (const resolved of texResolved) {
    if (resolved) results.add(resolved);
  }
  for (const resolved of bibResolved) {
    if (resolved) results.add(resolved);
  }

  return [...results];
}
