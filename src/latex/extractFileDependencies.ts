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

/** Comment line pattern — lines starting with optional whitespace then %. */
const COMMENT_LINE = /^\s*%/;

/**
 * Strip full-line comments from LaTeX content.
 * Inline comments (mid-line %) are kept to avoid breaking regex matching
 * on the same line; the extracted paths themselves never contain %.
 */
function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** Matches \input{path} — LaTeX does NOT add .tex automatically for \input
 *  but many authors omit it. We try both with and without .tex. */
const INPUT_PATTERN = /\\input\s*\{([^}]+)\}/g;

/** Matches \include{path} — LaTeX always appends .tex for \include. */
const INCLUDE_PATTERN = /\\include\s*\{([^}]+)\}/g;

/** Matches \bibliography{file1,file2,...} */
const BIBLIOGRAPHY_PATTERN = /\\bibliography\s*\{([^}]+)\}/g;

/** Matches \addbibresource{file.bib} (biblatex). */
const ADDBIBRESOURCE_PATTERN = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Try to resolve a TeX input path to an existing file.
 * Checks the path as-is first, then with .tex appended.
 */
async function resolveTexInputPath(
  rawPath: string,
  baseDir: string,
): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const absolute = joinLatexPath(baseDir, trimmed);

  // Check as-is first (author may have included .tex)
  if (
    await flexibleFS.exists({ kind: 'external', absolutePath: absolute })
  ) {
    return path.relative(baseDir, absolute);
  }

  // Try with .tex appended
  const withExt = ensureExtension(absolute, '.tex');
  if (
    withExt !== absolute &&
    (await flexibleFS.exists({ kind: 'external', absolutePath: withExt }))
  ) {
    return path.relative(baseDir, withExt);
  }

  return null;
}

/**
 * Try to resolve a bibliography path to an existing file.
 * Always ensures .bib extension.
 */
async function resolveBibPath(
  rawPath: string,
  baseDir: string,
): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const withExt = ensureExtension(trimmed, '.bib');
  const absolute = joinLatexPath(baseDir, withExt);

  if (
    await flexibleFS.exists({ kind: 'external', absolutePath: absolute })
  ) {
    return path.relative(baseDir, absolute);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract file dependencies (\input, \include, \bibliography, \addbibresource)
 * from a LaTeX file. Returns workspace-relative paths to existing files.
 *
 * Only returns files that actually exist on disk, similar to how
 * extractFigurePathsFromLatex works for \includegraphics.
 */
export async function extractLatexFileDependencies(
  latexFileLocation: FileLocation,
): Promise<string[]> {
  const latexDir = path.dirname(latexFileLocation.absolutePath);
  const content = await flexibleFS.read(latexFileLocation);
  const uncommented = stripCommentLines(content);

  const discovered = new Set<string>();
  const results: string[] = [];

  const addResult = (relativePath: string) => {
    if (!discovered.has(relativePath)) {
      discovered.add(relativePath);
      results.push(relativePath);
    }
  };

  // Collect raw paths from all patterns
  const texInputPaths: string[] = [];
  for (const match of uncommented.matchAll(INPUT_PATTERN)) {
    texInputPaths.push(match[1]);
  }
  for (const match of uncommented.matchAll(INCLUDE_PATTERN)) {
    texInputPaths.push(match[1]);
  }

  const bibPaths: string[] = [];
  for (const match of uncommented.matchAll(BIBLIOGRAPHY_PATTERN)) {
    // \bibliography can have comma-separated entries
    for (const entry of match[1].split(',')) {
      bibPaths.push(entry);
    }
  }
  for (const match of uncommented.matchAll(ADDBIBRESOURCE_PATTERN)) {
    bibPaths.push(match[1]);
  }

  // Resolve TeX input dependencies
  const texResolved = await Promise.all(
    texInputPaths.map((raw) => resolveTexInputPath(raw, latexDir)),
  );
  for (const resolved of texResolved) {
    if (resolved) addResult(resolved);
  }

  // Resolve bibliography dependencies
  const bibResolved = await Promise.all(
    bibPaths.map((raw) => resolveBibPath(raw, latexDir)),
  );
  for (const resolved of bibResolved) {
    if (resolved) addResult(resolved);
  }

  return results;
}
