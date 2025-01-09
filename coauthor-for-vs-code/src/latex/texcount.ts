// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { fileExists } from '../utils/fileUtils';
import { executeCommand } from '../utils/execUtils';
import { checkToolInstalled } from './texTools';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

/**
 * Get full statistics for LaTeX documents using the texcount Perl script
 * @param filePaths Single file path or array of file paths
 * @param merge Whether to merge included files in the count
 * @param channel The channel to use for logging
 * @returns Promise<string | null> String containing full texcount output for all files, or null if an error occurred
 */
export async function getTexCount(
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
      command.push(`"${filePath}"`);

      const result = await executeCommand(command, {
        channel,
        truncate: false, // Don't truncate texcount output as we need the full statistics
      });
      if (result.success && result.stdout) {
        allOutputs.push(`Tex Count Results for ${filePath}:\n${result.stdout}`);
        logger.debug(channel, `Successfully counted ${filePath}`);
      } else {
        logger.error(channel, `Error getting tex count for ${filePath}`);
        if (result.stdout) logger.error(channel, `Stdout: ${result.stdout}`);
        if (result.stderr) logger.error(channel, `Stderr: ${result.stderr}`);
      }
    }

    if (allOutputs.length > 0) {
      const combinedOutput = allOutputs.join('\n\n');
      logger.info(channel, `Combined Tex Count Results:\n${combinedOutput}`);
      return combinedOutput;
    }

    return null;
  } catch (err) {
    logger.error(
      channel,
      `Error in getTexCount: ${err instanceof Error ? err.message : String(err)}`,
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
export async function getTexCountStats(
  filePaths: string | string[],
  channel: string = CHANNEL,
): Promise<string | null> {
  const texcountStats = await getTexCount(filePaths, false, channel);
  return texcountStats
    ? `Tex Count Statistics:<texcount>\n${texcountStats}\n</texcount>\n\n`
    : null;
}
