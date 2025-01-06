// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, fileExists } from '../utils/fileUtils';

const CHANNEL = 'LaTeX';
logger.initialize(CHANNEL);

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

  let outerMatch;
  while ((outerMatch = graphicspathPattern.exec(content)) !== null) {
    const outerContent = outerMatch[1];
    let pathMatch;
    while ((pathMatch = pathPattern.exec(outerContent)) !== null) {
      let path = pathMatch[1].trim();
      // Ensure path has trailing slash
      if (path && !path.endsWith('/')) {
        path += '/';
      }
      if (path) {
        paths.push(path);
      }
    }
  }

  return paths;
}

/**
 * Extract figure paths from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of relative paths to figures
 */
export async function extractFigurePathsFromLatex(
  latexFile: string,
): Promise<string[]> {
  const figurePaths: string[] = [];

  try {
    const latexDir = path.dirname(latexFile);
    let graphicspaths = [latexDir]; // Start with the directory of the LaTeX file

    // Regular expressions to match figure inclusion commands
    const figurePatterns = [
      /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
      /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g,
    ];

    // Read file content
    const content = await readFile(latexFile);

    // Parse graphicspaths
    const paths = parseGraphicspath(content);
    for (const p of paths) {
      const normalizedPath = path.normalize(
        path.join(latexDir, p.replace(/^\/+|\/+$/g, '')),
      );
      graphicspaths.push(normalizedPath);
      logger.debug(CHANNEL, `Added graphicspath: ${normalizedPath}`);
    }

    logger.debug(CHANNEL, `Graphicspaths: ${graphicspaths.join(', ')}`);

    // Find all matches in the content for both patterns
    for (const pattern of figurePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const figPath = match[1];
        for (const basePath of graphicspaths) {
          const normPath = path.normalize(path.join(basePath, figPath));
          // Try with common extensions if no extension is provided
          const extensions = figPath.includes('.')
            ? ['']
            : ['.pdf', '.png', '.jpg', '.jpeg'];

          for (const ext of extensions) {
            const pathToCheck = normPath + ext;
            const relPath = path.relative(latexDir, pathToCheck);
            if (await fileExists(relPath)) {
              figurePaths.push(relPath);
              logger.debug(CHANNEL, `Found figure: ${relPath}`);
              break;
            }
          }
        }
      }
    }

    logger.debug(CHANNEL, `Found figures: ${figurePaths.join(', ')}`);
    return figurePaths;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error extracting figure paths: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
