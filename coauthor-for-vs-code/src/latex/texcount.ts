// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { fileExists } from '../utils/fileUtils';
import { executeCommand } from '../utils/execUtils';

const CHANNEL = 'LaTeX';
logger.initializeLogging(CHANNEL);

/**
 * Get full statistics for LaTeX documents using the texcount Perl script
 * @param filePaths Single file path or array of file paths
 * @param merge Whether to merge included files in the count
 * @returns Promise<string | null> String containing full texcount output for all files, or null if an error occurred
 */
export async function getTexCount(
  filePaths: string | string[],
  merge: boolean = false,
): Promise<string | null> {
  try {
    // Convert single path to array
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const allOutputs: string[] = [];

    for (const filePath of paths) {
      if (!(await fileExists(filePath))) {
        logger.warn(CHANNEL, `Warning: File ${filePath} does not exist.`);
        continue;
      }

      if (!filePath.endsWith('.tex')) {
        logger.warn(
          CHANNEL,
          `Error: File ${filePath} is not a LaTeX file. Skipping.`,
        );
        continue;
      }

      const command = ['texcount'];
      if (merge) {
        command.push('-merge');
      }
      command.push(`"${filePath}"`);

      const result = await executeCommand(command, {
        channel: CHANNEL,
        truncate: false, // Don't truncate texcount output as we need the full statistics
      });
      if (result.success && result.stdout) {
        allOutputs.push(`Tex Count Results for ${filePath}:\n${result.stdout}`);
        logger.debug(CHANNEL, `Successfully counted ${filePath}`);
      } else {
        logger.error(CHANNEL, `Error getting tex count for ${filePath}`);
        if (result.stdout) logger.error(CHANNEL, `Stdout: ${result.stdout}`);
        if (result.stderr) logger.error(CHANNEL, `Stderr: ${result.stderr}`);
      }
    }

    if (allOutputs.length > 0) {
      const combinedOutput = allOutputs.join('\n\n');
      logger.info(CHANNEL, `Combined Tex Count Results:\n${combinedOutput}`);
      return combinedOutput;
    }

    return null;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in getTexCount: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Run texcount on LaTeX files and return formatted statistics with XML-style tags
 * @param filePaths Single file path or array of file paths
 * @returns Promise<string | null> String containing formatted texcount statistics with XML tags, or null if an error occurred
 */
export async function getTexCountStats(
  filePaths: string | string[],
): Promise<string | null> {
  const texCountStats = await getTexCount(filePaths);
  return texCountStats
    ? `Tex Count Statistics:<texcount>\n${texCountStats}\n</texcount>\n\n`
    : null;
}
