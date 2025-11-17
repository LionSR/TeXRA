// Standard library imports
import * as path from 'path';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { flexibleFS } from '@utils/files';

const CHANNEL = 'LaTeXCommands';
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
    const graphicspaths = [latexDir]; // Start with the directory of the LaTeX file

    // Regular expressions to match figure inclusion commands
    const figurePatterns = [
      /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
      /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g,
    ];

    // Read file content
    const content = await flexibleFS.read(latexFile);

    // Parse graphicspaths
    const paths = parseGraphicspath(content);
    for (const p of paths) {
      const normalizedPath = path.normalize(
        path.join(latexDir, p.replace(/^\/+|\/+$/g, '')),
      );
      graphicspaths.push(normalizedPath);
    }

    // logger.debug(CHANNEL, `Graphicspaths: ${graphicspaths.join(', ')}`);

    // Pre-process content to remove commented lines
    const processedLines = content
      .split('\n')
      .filter((line) => !/^\s*%/.test(line)) // Remove lines that start with whitespace + %
      .join('\n');

    // Find all matches in the processed content for both patterns
    const discovered = new Set<string>();

    for (const pattern of figurePatterns) {
      let match;
      while ((match = pattern.exec(processedLines)) !== null) {
        const figPath = match[1];
        let found = false;
        for (const basePath of graphicspaths) {
          const normPath = path.normalize(path.join(basePath, figPath));
          // Try with common extensions if no extension is provided
          const extensions = figPath.includes('.')
            ? ['']
            : ['.pdf', '.png', '.jpg', '.jpeg'];

          for (const ext of extensions) {
            const pathToCheck = normPath + ext;

            if (await flexibleFS.exists(pathToCheck)) {
              const relative = path.relative(latexDir, pathToCheck);
              if (!discovered.has(relative)) {
                figurePaths.push(relative);
                discovered.add(relative);
              }
              found = true;
              break;
            }
          }

          if (found) {
            break;
          }
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
