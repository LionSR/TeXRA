// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

/**
 * Check if a LaTeX file contains Chinese-related packages
 * @param filePath Path to the LaTeX file
 * @returns Promise<boolean> True if the file contains Chinese packages
 */
async function hasChinesePackages(filePath: string): Promise<boolean> {
  try {
    const content = await WorkspaceFS.read(filePath);
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
 * @param options Options to control merging behavior and logging channel
 * @returns Promise<string | null> String containing full texcount output for all files, or null if an error occurred
 */
export type TexcountMode = 'separate' | 'include' | 'sum';

export interface TexcountOptions {
  mode?: TexcountMode;
  channel?: string;
}

async function validateTexFile(
  filePath: string,
  channel: string,
): Promise<boolean> {
  if (!(await WorkspaceFS.exists(filePath))) {
    logger.warn(channel, `File ${filePath} does not exist.`);
    return false;
  }

  if (!filePath.endsWith('.tex')) {
    logger.warn(
      channel,
      `Error: File ${filePath} is not a LaTeX file. Skipping.`,
    );
    return false;
  }

  return true;
}

async function detectChineseMode(
  filePath: string,
  channel: string,
): Promise<boolean> {
  if (await hasChinesePackages(filePath)) {
    logger.debug(
      channel,
      `Chinese packages detected in ${filePath}, enabling Chinese character counting`,
    );
    return true;
  }

  return false;
}

async function runTexcount(
  args: string[],
  channel: string,
  context: string,
): Promise<string | null> {
  const result = await runToolWithCheck('texcount', args, {
    channel,
    truncate: false,
    showError: true,
  });

  if (!result) {
    return null;
  }

  if (result.success && result.stdout) {
    logger.debug(channel, `Successfully counted ${context}`);
    return result.stdout;
  }

  logger.error(channel, `Error getting tex count for ${context}`);
  if (result.stdout) {
    logger.error(channel, `Stdout: ${result.stdout}`);
  }
  if (result.stderr) {
    logger.error(channel, `Stderr: ${result.stderr}`);
  }

  return null;
}

async function getIndividualCounts(
  paths: string[],
  channel: string,
  includeReferenced: boolean,
): Promise<string[]> {
  const outputs: string[] = [];

  for (const filePath of paths) {
    if (!(await validateTexFile(filePath, channel))) {
      continue;
    }

    const args: string[] = [];
    if (includeReferenced) {
      args.push('-inc');
    }
    if (await detectChineseMode(filePath, channel)) {
      args.push('-ch-only');
    }
    args.push(filePath);

    const stdout = await runTexcount(args, channel, filePath);
    if (stdout) {
      outputs.push(`TeX Count Results for ${filePath}:\n${stdout}`);
    }
  }

  return outputs;
}

async function getSummedCount(
  paths: string[],
  channel: string,
): Promise<string | null> {
  const validPaths: string[] = [];
  let enableChineseMode = false;

  for (const filePath of paths) {
    if (!(await validateTexFile(filePath, channel))) {
      continue;
    }

    validPaths.push(filePath);

    if (!enableChineseMode && (await hasChinesePackages(filePath))) {
      enableChineseMode = true;
      logger.debug(
        channel,
        `Chinese packages detected in ${filePath}, enabling Chinese character counting`,
      );
    }
  }

  if (validPaths.length === 0) {
    return null;
  }

  const args: string[] = ['-sum'];
  if (enableChineseMode) {
    args.push('-ch-only');
  }
  args.push(...validPaths);

  const stdout = await runTexcount(
    args,
    channel,
    `sum for ${validPaths.join(', ')}`,
  );
  if (!stdout) {
    return null;
  }

  return `Combined TeX Count Results (sum):\n${stdout}`;
}

export async function getTeXCount(
  filePaths: string | string[],
  { mode = 'separate', channel = CHANNEL }: TexcountOptions = {},
): Promise<string | null> {
  try {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const resolvedChannel = channel ?? CHANNEL;

    if (mode === 'sum') {
      const sumOutput = await getSummedCount(paths, resolvedChannel);
      if (sumOutput) {
        logger.info(
          resolvedChannel,
          `Combined TeX Count Results:\n${sumOutput}`,
        );
      }
      return sumOutput;
    }

    const includeReferenced = mode === 'include';
    const outputs = await getIndividualCounts(
      paths,
      resolvedChannel,
      includeReferenced,
    );
    if (outputs.length === 0) {
      return null;
    }

    const combinedOutput = outputs.join('\n\n');
    logger.info(
      resolvedChannel,
      `Combined TeX Count Results:\n${combinedOutput}`,
    );
    return combinedOutput;
  } catch (err) {
    logger.error(
      channel ?? CHANNEL,
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
export function formatTeXCountStats(texcountOutput: string): string {
  return `TeX Count Statistics:<texcount>\n${texcountOutput}\n</texcount>\n\n`;
}

export async function getTeXCountStats(
  filePaths: string | string[],
  channel: string = CHANNEL,
): Promise<string | null> {
  const texcountStats = await getTeXCount(filePaths, { channel });
  return texcountStats ? formatTeXCountStats(texcountStats) : null;
}
