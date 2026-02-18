import { z } from 'zod';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { flexibleFS, pathToLocation } from '@utils/files';
import type { FileLocation } from '@utils/files';
import { runToolWithCheck } from '@utils/system';
import { hasExtension } from '@utils/core/pathCore';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

/**
 * Check if a LaTeX file contains Chinese-related packages
 * @param filePath Path to the LaTeX file
 * @returns Promise<boolean> True if the file contains Chinese packages
 */
async function hasChinesePackages(
  fileLocation: FileLocation,
): Promise<boolean> {
  try {
    const content = await flexibleFS.read(fileLocation);
    const chinesePackages = [
      'xeCJK',
      'ctexart',
      'ctex',
      'CJK',
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
      `Error checking Chinese packages: ${toErrorMessage(err)}`,
    );
    return false;
  }
}

// ============================================================================
// Texcount Schemas
// ============================================================================

export const TexcountModeSchema = z.enum(['separate', 'include', 'sum']);
export type TexcountMode = z.infer<typeof TexcountModeSchema>;

export const TexcountOptionsSchema = z.object({
  mode: TexcountModeSchema.optional(),
  channel: z.string().optional(),
});
export type TexcountOptions = z.infer<typeof TexcountOptionsSchema>;

export const TexcountResultSchema = z.object({
  output: z.string().nullable(),
  errors: z.array(z.string()),
});
export type TexcountResult = z.infer<typeof TexcountResultSchema>;

/** Internal validation result - simple discriminated union */
type ValidationResult = { valid: true } | { valid: false; reason: string };

async function validateTexFile(
  fileLocation: FileLocation,
  channel: string,
): Promise<ValidationResult> {
  const filePath = fileLocation.absolutePath;
  if (!(await flexibleFS.exists(fileLocation))) {
    const reason = `File ${filePath} does not exist.`;
    logger.warn(channel, reason);
    return { valid: false, reason };
  }

  if (!hasExtension(filePath, '.tex')) {
    const reason = `Error: File ${filePath} is not a LaTeX file. Skipping.`;
    logger.warn(channel, reason);
    return { valid: false, reason };
  }

  return { valid: true };
}

async function runTexcount(
  args: string[],
  channel: string,
  context: string,
): Promise<{ stdout: string | null; error?: string }> {
  const result = await runToolWithCheck('texcount', args, {
    channel,
    truncate: false,
    showError: true,
  });

  if (!result) {
    return {
      stdout: null,
      error: `texcount did not return a result for ${context}.`,
    };
  }

  if (result.success && result.stdout) {
    logger.debug(channel, `Successfully counted ${context}`);
    return { stdout: result.stdout };
  }

  logger.error(channel, `Error getting tex count for ${context}`);
  if (result.stdout) {
    logger.error(channel, `Stdout: ${result.stdout}`);
  }
  if (result.stderr) {
    logger.error(channel, `Stderr: ${result.stderr}`);
  }

  return {
    stdout: null,
    error:
      `texcount failed while processing ${context}.` +
      (result.stderr ? ` Details: ${result.stderr}` : ''),
  };
}

async function getIndividualCounts(
  paths: string[],
  channel: string,
  includeReferenced: boolean,
): Promise<{ outputs: string[]; errors: string[] }> {
  const results = await Promise.all(
    paths.map(async (filePath) => {
      const fileLocation = pathToLocation(filePath);
      const localErrors: string[] = [];
      const validation = await validateTexFile(fileLocation, channel);
      if (!validation.valid) {
        localErrors.push(validation.reason);
        return { output: null, errors: localErrors };
      }

      const args: string[] = [];
      if (includeReferenced) {
        args.push('-inc');
      }
      if (await hasChinesePackages(fileLocation)) {
        args.push('-ch-only');
      }
      args.push(filePath);

      const { stdout, error } = await runTexcount(args, channel, filePath);
      if (stdout) {
        return {
          output: `TeX Count Results for ${filePath}:\n${stdout}`,
          errors: localErrors,
        };
      }
      if (error) {
        localErrors.push(error);
      }
      return { output: null, errors: localErrors };
    }),
  );

  const outputs = results
    .map((result) => result.output)
    .filter((output): output is string => output !== null);
  const errors = results.flatMap((result) => result.errors);

  return { outputs, errors };
}

async function getSummedCount(
  paths: string[],
  channel: string,
): Promise<{ output: string | null; errors: string[] }> {
  const validPaths: string[] = [];
  const errors: string[] = [];
  let enableChineseMode = false;

  for (const filePath of paths) {
    const fileLocation = pathToLocation(filePath);
    const validation = await validateTexFile(fileLocation, channel);
    if (!validation.valid) {
      errors.push(validation.reason);
      continue;
    }

    validPaths.push(filePath);

    if (!enableChineseMode && (await hasChinesePackages(fileLocation))) {
      enableChineseMode = true;
      logger.debug(
        channel,
        `Chinese packages detected in ${filePath}, enabling Chinese character counting`,
      );
    }
  }

  if (validPaths.length === 0) {
    return {
      output: null,
      errors:
        errors.length > 0
          ? errors
          : ['No valid LaTeX files were provided for texcount sum mode.'],
    };
  }

  const args: string[] = ['-sum'];
  if (enableChineseMode) {
    args.push('-ch-only');
  }
  args.push(...validPaths);

  const { stdout, error } = await runTexcount(
    args,
    channel,
    `sum for ${validPaths.join(', ')}`,
  );
  if (!stdout) {
    if (error) {
      errors.push(error);
    }
    return { output: null, errors };
  }

  return {
    output: `Combined TeX Count Results (sum):\n${stdout}`,
    errors,
  };
}

export async function getTeXCount(
  filePaths: string | string[],
  { mode = 'separate', channel }: TexcountOptions = {},
): Promise<TexcountResult> {
  const resolvedChannel = channel ?? CHANNEL;

  try {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const trimmedPaths = paths
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0);

    if (trimmedPaths.length === 0) {
      const message = 'No LaTeX files provided for texcount.';
      logger.warn(resolvedChannel, message);
      return { output: null, errors: [message] };
    }

    if (mode === 'sum') {
      const { output, errors } = await getSummedCount(
        trimmedPaths,
        resolvedChannel,
      );
      if (output) {
        logger.info(resolvedChannel, `Combined TeX Count Results:\n${output}`);
      }
      return { output, errors };
    }

    const includeReferenced = mode === 'include';
    const { outputs, errors } = await getIndividualCounts(
      trimmedPaths,
      resolvedChannel,
      includeReferenced,
    );
    if (outputs.length === 0) {
      if (errors.length === 0) {
        errors.push('texcount did not return output for the requested files.');
      }
      return { output: null, errors };
    }

    const combinedOutput = outputs.join('\n\n');
    logger.info(
      resolvedChannel,
      `Combined TeX Count Results:\n${combinedOutput}`,
    );
    return { output: combinedOutput, errors };
  } catch (err) {
    const errorMessage = `Error in getTeXCount: ${toErrorMessage(err)}`;
    logger.error(resolvedChannel, errorMessage);
    return { output: null, errors: [errorMessage] };
  }
}

export async function getTeXCountStats(
  filePaths: string | string[],
  channel: string = CHANNEL,
): Promise<string | null> {
  const { output } = await getTeXCount(filePaths, { channel });
  return output
    ? `TeX Count Statistics:<texcount>\n${output}\n</texcount>\n\n`
    : null;
}
