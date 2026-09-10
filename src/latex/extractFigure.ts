// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

import type { FileLocation } from '@shared/schemas';
import { filterNotNull } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { ensureError } from '@utils/errors/errorMessage';
import { joinLatexPath } from '@utils/core/pathCore';

import {
  findExistingLatexPath,
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

  const extractedPaths: string[] = [];
  for (const outerMatch of content.matchAll(graphicspathPattern)) {
    for (const pathMatch of outerMatch[1].matchAll(pathPattern)) {
      const trimmed = pathMatch[1].trim();
      if (!trimmed) {
        continue;
      }
      extractedPaths.push(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
    }
  }

  return extractedPaths;
}

/**
 * Resolve a figure path by searching through possible base paths and
 * extensions. Returns a path relative to `latexDir`, or null.
 */
const resolveFigurePath = Effect.fn('latex.resolveFigurePath')(function* (
  figPath: string,
  searchPaths: readonly string[],
  latexDir: string,
) {
  const extensions = figPath.includes('.') ? [''] : FIGURE_EXTENSIONS;
  const absolute = yield* findExistingLatexPath(
    figPath,
    searchPaths,
    extensions,
  );
  return absolute === null ? null : path.relative(latexDir, absolute);
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
  const graphicspaths = [latexDir]; // Start with the directory of the LaTeX file

  // Regular expressions to match figure inclusion commands
  const figurePatterns = [
    /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
    /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g,
  ];

  const content = yield* Effect.tryPromise({
    try: () => AbsoluteFS.read(latexFileLocation.absolutePath),
    catch: ensureError,
  });

  // Pre-process content to remove commented-out text (including inline
  // comments and escaped `\%`, unlike a naive whole-line strip).
  const processedContent = stripLatexComments(content);

  // Parse graphicspaths
  for (const p of parseGraphicspath(processedContent)) {
    graphicspaths.push(joinLatexPath(latexDir, p));
  }

  const referenced = figurePatterns.flatMap((pattern) =>
    [...processedContent.matchAll(pattern)].map((match) => match[1]),
  );

  const resolved = yield* Effect.forEach(
    referenced,
    (figPath) => resolveFigurePath(figPath, graphicspaths, latexDir),
    { concurrency: RESOLVE_CONCURRENCY },
  );

  return [...new Set(resolved.filter(filterNotNull))];
});
