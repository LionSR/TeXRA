// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Predicate } from 'effect';

import { ensureError, type FileLocation } from '@texra-ai/harness/schemas';
import { readNormalizedFile } from '@texra-ai/harness/node';

import {
  existingExternalPath,
  joinLatexPath,
  resolveLatexDir,
  stripLatexComments,
} from './latexParsingUtils';

const FIGURE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];

/** Figure lookups run against the filesystem, so bound the fan-out. */
const RESOLVE_CONCURRENCY = 8;

/**
 * Parse graphicspath commands supporting both single and multiple path formats.
 * Each entry is trimmed and given a trailing slash; blank entries are skipped.
 * @param content LaTeX file content
 * @returns Array of paths found in graphicspath commands
 */
function parseGraphicspath(content: string): string[] {
  const graphicspathPattern = /\\graphicspath\s*\{((?:\s*\{[^{}]+\}\s*)+)\}/g;
  const pathPattern = /\{([^{}]+)\}/g;

  return [...content.matchAll(graphicspathPattern)].flatMap((outerMatch) =>
    [...outerMatch[1].matchAll(pathPattern)]
      .map((pathMatch) => pathMatch[1].trim())
      .filter((trimmed) => trimmed !== '')
      .map((trimmed) => (trimmed.endsWith('/') ? trimmed : `${trimmed}/`)),
  );
}

/**
 * Resolve a figure path against each search path in order, trying the figure
 * extensions when the reference has none. The first existing file wins and
 * later candidates are never probed. Returns a path relative to `latexDir`,
 * or null.
 */
const resolveFigurePath = Effect.fn('latex.resolveFigurePath')(function* (
  figPath: string,
  searchPaths: readonly string[],
  latexDir: string,
) {
  const extensions = figPath.includes('.') ? [''] : FIGURE_EXTENSIONS;
  for (const basePath of searchPaths) {
    const joined = path.normalize(path.join(basePath, figPath));
    for (const ext of extensions) {
      const hit = yield* existingExternalPath(`${joined}${ext}`);
      if (hit !== null) return path.relative(latexDir, hit);
    }
  }
  return null;
});

/**
 * Extract figure paths from a LaTeX file.
 *
 * The resolutions run concurrently but `Effect.forEach` hands their results
 * back in source order, so the de-duplicated output stays deterministic.
 */
export const extractFigurePathsFromLatex = Effect.fn(
  'latex.extractFigurePathsFromLatex',
)(function* (latexFileLocation: FileLocation) {
  const latexDir = yield* resolveLatexDir(latexFileLocation.absolutePath);

  // Regular expressions to match figure inclusion commands
  const figurePatterns = [
    /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
    /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g,
  ];

  const fs = yield* FileSystem.FileSystem;
  const content = yield* readNormalizedFile(
    fs,
    latexFileLocation.absolutePath,
  ).pipe(Effect.mapError(ensureError));

  // Pre-process content to remove commented-out text (including inline
  // comments and escaped `\%`, unlike a naive whole-line strip).
  const processedContent = stripLatexComments(content);

  // The LaTeX file's own directory first, then its \graphicspath entries.
  const graphicspaths = [
    latexDir,
    ...parseGraphicspath(processedContent).map((p) =>
      joinLatexPath(latexDir, p),
    ),
  ];

  const referenced = figurePatterns.flatMap((pattern) =>
    [...processedContent.matchAll(pattern)].map((match) => match[1]),
  );

  const resolved = yield* Effect.forEach(
    referenced,
    (figPath) => resolveFigurePath(figPath, graphicspaths, latexDir),
    { concurrency: RESOLVE_CONCURRENCY },
  );

  return [...new Set(resolved.filter(Predicate.isNotNull))];
});
