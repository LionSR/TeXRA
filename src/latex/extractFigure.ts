// Standard library imports
import * as path from 'path';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { flexibleFS } from '@utils/files';
import type { FileLocation } from '@utils/files';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const FIGURE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];

function normalizePath(latexDir: string, relativePath: string): string {
  return path.normalize(
    path.join(latexDir, relativePath.replaceAll(/^\/+|\/+$/g, '')),
  );
}

/**
 * Parse graphicspath commands supporting both single and multiple path formats
 * @param content LaTeX file content
 * @returns Array of paths found in graphicspath commands
 */
function parseGraphicspath(content: string): string[] {
  const paths: string[] = [];
  // Match both single and multiple path formats
  const graphicspathPattern = /\\graphicspath\s*\{((?:\s*\{[^{}]+\}\s*)+)\}/g;
  // Pattern to extract individual paths from nested braces
  const pathPattern = /\{([^{}]+)\}/g;

  // Use flatMap to process outer matches and extract inner paths
  const extractedPaths = [...content.matchAll(graphicspathPattern)].flatMap(
    (outerMatch) =>
      [...outerMatch[1].matchAll(pathPattern)]
        .map((pathMatch) => {
          let p = pathMatch[1].trim();
          // Ensure path has trailing slash
          if (p && !p.endsWith('/')) {
            p += '/';
          }
          return p;
        })
        .filter(Boolean),
  );

  paths.push(...extractedPaths);
  return paths;
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

  try {
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
      graphicspaths.push(normalizePath(latexDir, p));
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
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error extracting figure paths: ${toErrorMessage(err)}`,
    );
    throw err;
  }
}
