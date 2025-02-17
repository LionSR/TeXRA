// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { fileExists, readFile } from '../utils/fileUtils';
import { executeCommand } from '../utils/execUtils';
import { checkToolInstalled } from './texTools';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

/**
 * Check if a LaTeX file contains Chinese-related packages
 * @param filePath Path to the LaTeX file
 * @returns Promise<boolean> True if the file contains Chinese packages
 */
async function hasChinesePackages(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath);
    const chinesePackages = [
      'xeCJK',
      'ctexart',
      'ctex',
      'CJK',
      'xeCJK',
      'ctexrep',
      'ctexbook',
    ];
    return chinesePackages.some(
      (pkg) =>
        content.includes(`\\usepackage{${pkg}}`) ||
        content.includes(`\\documentclass{${pkg}}`),
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error checking Chinese packages: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Get full statistics for LaTeX documents using the texcount Perl script
 * @param filePaths Single file path or array of file paths
 * @param merge Whether to merge included files in the count
 * @param channel The channel to use for logging
 * @returns Promise<string | null> String containing full texcount output for all files, or null if an error occurred
 */
export async function getTeXCount(
  filePaths: string | string[],
  merge: boolean = false,
  channel: string = CHANNEL,
): Promise<string | null> {
  try {
    // Check if texcount is installed
    if (!(await checkToolInstalled('texcount'))) {
      return null;
    }

    // Convert single path to array
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const allOutputs: string[] = [];

    for (const filePath of paths) {
      if (!(await fileExists(filePath))) {
        logger.warn(channel, `Warning: File ${filePath} does not exist.`);
        continue;
      }

      if (!filePath.endsWith('.tex')) {
        logger.warn(
          channel,
          `Error: File ${filePath} is not a LaTeX file. Skipping.`,
        );
        continue;
      }

      const command = ['texcount'];
      if (merge) {
        command.push('-merge');
      }

      // Add Chinese counting support if Chinese packages are detected
      if (await hasChinesePackages(filePath)) {
        command.push('-ch-only'); // Use Chinese-only mode for accurate character counting
        logger.debug(
          channel,
          `Chinese packages detected in ${filePath}, enabling Chinese character counting`,
        );
      }

      command.push(`"${filePath}"`);

      const result = await executeCommand(command, {
        channel,
        truncate: false, // Don't truncate texcount output as we need the full statistics
      });
      if (result.success && result.stdout) {
        allOutputs.push(`TeX Count Results for ${filePath}:\n${result.stdout}`);
        logger.debug(channel, `Successfully counted ${filePath}`);
      } else {
        logger.error(channel, `Error getting tex count for ${filePath}`);
        if (result.stdout) logger.error(channel, `Stdout: ${result.stdout}`);
        if (result.stderr) logger.error(channel, `Stderr: ${result.stderr}`);
      }
    }

    if (allOutputs.length > 0) {
      const combinedOutput = allOutputs.join('\n\n');
      logger.info(channel, `Combined TeX Count Results:\n${combinedOutput}`);
      return combinedOutput;
    }

    return null;
  } catch (err) {
    logger.error(
      channel,
      `Error in getTeXCount: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Run texcount on LaTeX files and return formatted statistics with XML-style tags
 * @param filePaths Single file path or array of file paths
 * @param channel The channel to use for logging
 * @returns Promise<string | null> String containing formatted texcount statistics with XML tags, or null if an error occurred
 */
export async function getTeXCountStats(
  filePaths: string | string[],
  channel: string = CHANNEL,
): Promise<string | null> {
  const texcountStats = await getTeXCount(filePaths, false, channel);
  return texcountStats
    ? `TeX Count Statistics:<texcount>\n${texcountStats}\n</texcount>\n\n`
    : null;
}
