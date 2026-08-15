import { createLog } from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { filterNotNull, filterNotNullish, ensureArray } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';

const log = createLog(CHANNEL);

const CHINESE_PACKAGES = [
  'xeCJK',
  'ctexart',
  'ctex',
  'CJK',
  'ctexrep',
  'ctexbook',
];

async function hasChinesePackages(
  fileLocation: FileLocation,
): Promise<boolean> {
  try {
    const content = await AbsoluteFS.read(fileLocation.absolutePath);
    return CHINESE_PACKAGES.some(
      (pkg) =>
        content.includes(`\\usepackage{${pkg}}`) ||
        content.includes(`\\documentclass{${pkg}}`),
    );
  } catch (err) {
    log.error(`Error checking Chinese packages: ${toErrorMessage(err)}`);
    return false;
  }
}

export type TexcountMode = 'separate' | 'include' | 'sum';

export interface TexcountOptions {
  mode?: TexcountMode;
  channel?: string;
}

export interface TexcountResult {
  output: string | null;
  errors: string[];
}

/** Returns why the file cannot be counted, or null when it is countable. */
async function rejectionReason(
  fileLocation: FileLocation,
  channel: string,
): Promise<string | null> {
  const filePath = fileLocation.absolutePath;
  const log = createLog(channel);
  if (!(await AbsoluteFS.exists(filePath))) {
    const reason = `File ${filePath} does not exist.`;
    log.warn(reason);
    return reason;
  }

  if (!hasExtension(filePath, '.tex')) {
    const reason = `Error: File ${filePath} is not a LaTeX file. Skipping.`;
    log.warn(reason);
    return reason;
  }

  return null;
}

async function runTexcount(
  args: string[],
  channel: string,
  context: string,
  signal?: AbortSignal,
): Promise<{ stdout: string | null; error?: string }> {
  const log = createLog(channel);
  const result = await runToolWithCheck('texcount', args, {
    channel,
    truncate: false,
    showError: true,
    signal,
  });

  if (!result) {
    return {
      stdout: null,
      error: `texcount did not return a result for ${context}.`,
    };
  }

  if (result.success && result.stdout) {
    log.debug(`Successfully counted ${context}`);
    return { stdout: result.stdout };
  }

  log.error(`Error getting tex count for ${context}`);
  if (result.stdout) {
    log.error(`Stdout: ${result.stdout}`);
  }
  if (result.stderr) {
    log.error(`Stderr: ${result.stderr}`);
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
  signal?: AbortSignal,
): Promise<{ outputs: string[]; errors: string[] }> {
  const results = await Promise.all(
    paths.map(async (filePath) => {
      const fileLocation = pathToLocation(filePath);
      const reason = await rejectionReason(fileLocation, channel);
      if (reason) {
        return { output: null, error: reason };
      }

      const args: string[] = [];
      if (includeReferenced) {
        args.push('-inc');
      }
      if (await hasChinesePackages(fileLocation)) {
        args.push('-ch-only');
      }
      args.push(filePath);

      const { stdout, error } = await runTexcount(
        args,
        channel,
        filePath,
        signal,
      );
      return stdout
        ? { output: `TeX Count Results for ${filePath}:\n${stdout}`, error }
        : { output: null, error };
    }),
  );

  return {
    outputs: results.map((result) => result.output).filter(filterNotNull),
    errors: results.map((result) => result.error).filter(filterNotNullish),
  };
}

async function getSummedCount(
  paths: string[],
  channel: string,
  signal?: AbortSignal,
): Promise<{ output: string | null; errors: string[] }> {
  const log = createLog(channel);
  const validPaths: string[] = [];
  const errors: string[] = [];
  let enableChineseMode = false;

  for (const filePath of paths) {
    const fileLocation = pathToLocation(filePath);
    const reason = await rejectionReason(fileLocation, channel);
    if (reason) {
      errors.push(reason);
      continue;
    }

    validPaths.push(filePath);

    if (!enableChineseMode && (await hasChinesePackages(fileLocation))) {
      enableChineseMode = true;
      log.debug(
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
    signal,
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
  // `signal` rides alongside the schema-derived options: it's a runtime
  // capability, not data, so it stays out of the Zod schema.
  {
    mode = 'separate',
    channel,
    signal,
  }: TexcountOptions & { signal?: AbortSignal } = {},
): Promise<TexcountResult> {
  const resolvedChannel = channel ?? CHANNEL;
  const log = createLog(resolvedChannel);

  try {
    const paths = ensureArray(filePaths);
    const trimmedPaths = paths
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0);

    if (trimmedPaths.length === 0) {
      const message = 'No LaTeX files provided for texcount.';
      log.warn(message);
      return { output: null, errors: [message] };
    }

    if (mode === 'sum') {
      const { output, errors } = await getSummedCount(
        trimmedPaths,
        resolvedChannel,
        signal,
      );
      if (output) {
        log.info(`Combined TeX Count Results:\n${output}`);
      }
      return { output, errors };
    }

    const includeReferenced = mode === 'include';
    const { outputs, errors } = await getIndividualCounts(
      trimmedPaths,
      resolvedChannel,
      includeReferenced,
      signal,
    );
    if (outputs.length === 0) {
      if (errors.length === 0) {
        errors.push('texcount did not return output for the requested files.');
      }
      return { output: null, errors };
    }

    const combinedOutput = outputs.join('\n\n');
    log.info(`Combined TeX Count Results:\n${combinedOutput}`);
    return { output: combinedOutput, errors };
  } catch (err) {
    const errorMessage = `Error in getTeXCount: ${toErrorMessage(err)}`;
    log.error(errorMessage);
    return { output: null, errors: [errorMessage] };
  }
}

export interface TeXCountStat {
  label: string;
}

/** Headline stats extracted from texcount's raw text report, in display order. */
const TEXCOUNT_STAT_PATTERNS: readonly [RegExp, string][] = [
  [/Words in text:\s*(\d+)/, 'Text: $1 words'],
  [/Words in headers:\s*(\d+)/, 'Headers: $1'],
  [/Words in float captions:\s*(\d+)/, 'Captions: $1'],
  [/Number of inline math:\s*(\d+)/, 'Inline math: $1'],
  [/Number of displayed math:\s*(\d+)/, 'Display math: $1'],
];

/** Parse texcount's raw text output into the headline stats it reports. */
export function parseTeXCountStats(output: string): TeXCountStat[] {
  return TEXCOUNT_STAT_PATTERNS.map(([pattern, template]) => {
    const match = output.match(pattern);
    return match ? { label: template.replace('$1', match[1]) } : null;
  }).filter(filterNotNull);
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
