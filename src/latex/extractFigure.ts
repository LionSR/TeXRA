// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '@logger/logUtils';
import { flexibleFS } from '@utils/files';
import type { FileLocation } from '@shared/schemas';
import { joinLatexPath } from '@utils/core/pathCore';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const FIGURE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];

/**
 * Normalize a path to ensure it has a trailing slash.
 */
function ensureTrailingSlash(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * Parse graphicspath commands supporting both single and multiple path formats.
 * @param content LaTeX file content
 * @returns Array of paths found in graphicspath commands
 */
function parseGraphicspath(content: string): string[] {
  const graphicspathPattern = /\\graphicspath\s*\{((?:\s*\{[^{}]+\}\s*)+)\}/g;
  const pathPattern = /\{([^{}]+)\}/g;

  const extractedPaths: string[] = [];
  for (const outerMatch of content.matchAll(graphicspathPattern)) {
    for (const pathMatch of outerMatch[1].matchAll(pathPattern)) {
      const normalized = ensureTrailingSlash(pathMatch[1]);
      if (normalized) {
        extractedPaths.push(normalized);
      }
    }
  }

  return extractedPaths;
}

/**
 * Resolve a figure path by searching through possible base paths and extensions
 */
async function resolveFigurePath(
  figPath: string,
  searchPaths: string[],
  latexDir: string,
): Promise<string | null> {
  const extensions = figPath.includes('.') ? [''] : FIGURE_EXTENSIONS;

  for (const basePath of searchPaths) {
    const normPath = path.normalize(path.join(basePath, figPath));

    for (const ext of extensions) {
      const pathToCheck = normPath + ext;
      if (
        await flexibleFS.exists({
          kind: 'external',
          absolutePath: pathToCheck,
        })
      ) {
        return path.relative(latexDir, pathToCheck);
      }
    }
  }
  return null;
}

/**
 * Extract figure paths from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of relative paths to figures
 */
export async function extractFigurePathsFromLatex(
  latexFileLocation: FileLocation,
): Promise<string[]> {
  const figurePaths: string[] = [];

  const latexFile = latexFileLocation.absolutePath;
  const latexDir = path.dirname(latexFile);
  const graphicspaths = [latexDir]; // Start with the directory of the LaTeX file

  // Regular expressions to match figure inclusion commands
  const figurePatterns = [
    /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
    /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g,
  ];

  // Read file content
  const content = await flexibleFS.read(latexFileLocation);

  // Parse graphicspaths
  const paths = parseGraphicspath(content);
  for (const p of paths) {
    graphicspaths.push(joinLatexPath(latexDir, p));
  }

  // Pre-process content to remove commented lines
  const processedLines = content
    .split('\n')
    .filter((line) => !/^\s*%/.test(line)) // Remove lines that start with whitespace + %
    .join('\n');

  // Find all matches in the processed content for both patterns
  const discovered = new Set<string>();

  for (const pattern of figurePatterns) {
    for (const match of processedLines.matchAll(pattern)) {
      const resolved = await resolveFigurePath(
        match[1],
        graphicspaths,
        latexDir,
      );
      if (resolved && !discovered.has(resolved)) {
        figurePaths.push(resolved);
        discovered.add(resolved);
      }
    }
  }

  return figurePaths;
}
