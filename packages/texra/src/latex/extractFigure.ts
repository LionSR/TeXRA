// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Predicate } from 'effect';

import type { FileLocation } from '@texra-ai/worldline/schemas';

import {
  existingExternalPath,
  joinLatexPath,
  resolveLatexDir,
  LATEX_PROBE_CONCURRENCY,
  readUncommentedLatex,
} from './latexParsingUtils';

const FIGURE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];

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
 * later candidates are never probed. Returns the absolute path, or null.
 */
const resolveFigurePath = Effect.fn('latex.resolveFigurePath')(function* (
  figPath: string,
  searchPaths: readonly string[],
) {
  const extensions = figPath.includes('.') ? [''] : FIGURE_EXTENSIONS;
  for (const basePath of searchPaths) {
    const joined = path.normalize(path.join(basePath, figPath));
    for (const ext of extensions) {
      const hit = yield* existingExternalPath(`${joined}${ext}`);
      if (hit !== null) return hit;
    }
  }
  return null;
});

/**
 * The absolute paths of the figures a LaTeX file includes that exist on
 * disk, resolved against the file's real directory (so a `.tex` symlinked
 * elsewhere still finds the figures beside its target).
 *
 * The resolutions run concurrently but `Effect.forEach` hands their results
 * back in source order, so the de-duplicated output stays deterministic.
 */
export const extractFigurePathsFromLatex = Effect.fn(
  'latex.extractFigurePathsFromLatex',
)(function* (latexFileLocation: FileLocation) {
  const latexDir = yield* resolveLatexDir(latexFileLocation.absolutePath);

  // The figure inclusion commands; LaTeX allows whitespace before each
  // argument.
  const figurePatterns = [
    /\\includegraphics\s*(?:\[.*?\])?\s*\{(.+?)\}/g,
    /\\begin\{overpic\}\s*(?:\[.*?\])?\s*\{(.+?)\}/g,
  ];

  const processedContent = yield* readUncommentedLatex(
    latexFileLocation.absolutePath,
  );

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
    (figPath) => resolveFigurePath(figPath, graphicspaths),
    { concurrency: LATEX_PROBE_CONCURRENCY },
  );

  return [...new Set(resolved.filter(Predicate.isNotNull))];
});
