import { Effect } from 'effect';

import { createLog } from '@logger/logUtils';
import { filterNotNull, filterNotNullish, ensureArray } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
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

/** texcount runs one subprocess per file, so bound the fan-out. */
const COUNT_CONCURRENCY = 4;

const hasChinesePackages = Effect.fn('texcount.hasChinesePackages')(function* (
  absolutePath: string,
) {
  return yield* Effect.tryPromise({
    try: () => AbsoluteFS.read(absolutePath),
    catch: ensureError,
  }).pipe(
    Effect.map((content) =>
      CHINESE_PACKAGES.some(
        (pkg) =>
          content.includes(`\\usepackage{${pkg}}`) ||
          content.includes(`\\documentclass{${pkg}}`),
      ),
    ),
    Effect.catch((err) =>
      Effect.sync(() => {
        log.error(`Error checking Chinese packages: ${toErrorMessage(err)}`);
        return false;
      }),
    ),
  );
});

export type TexcountMode = 'separate' | 'include' | 'sum';

export interface TexcountOptions {
  mode?: TexcountMode;
  channel?: string;
}

interface TexcountResult {
  output: string | null;
  errors: string[];
}

/** Returns why the file cannot be counted, or null when it is countable. */
const rejectionReason = Effect.fn('texcount.rejectionReason')(function* (
  filePath: string,
  channel: string,
) {
  const log = createLog(channel);
  const exists = yield* Effect.tryPromise({
    try: () => AbsoluteFS.exists(filePath),
    catch: ensureError,
  });
  if (!exists) {
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
});

/**
 * Invoke `texcount`. The subprocess is cancelled by the fiber's own
 * interruption: `Effect.tryPromise` hands the thunk an `AbortSignal` that
 * aborts when the fiber is interrupted, so no caller threads a signal in.
 */
const runTexcount = Effect.fn('texcount.runTexcount')(function* (
  args: string[],
  channel: string,
  context: string,
): Effect.fn.Return<{ stdout: string | null; error?: string }, Error> {
  const log = createLog(channel);
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      runToolWithCheck('texcount', args, {
        channel,
        truncate: false,
        showError: true,
        signal,
      }),
    catch: ensureError,
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
});

const getIndividualCounts = Effect.fn('texcount.getIndividualCounts')(
  function* (
    paths: readonly string[],
    channel: string,
    includeReferenced: boolean,
  ) {
    const results = yield* Effect.forEach(
      paths,
      (filePath) =>
        Effect.gen(function* () {
          const absolutePath = pathToLocation(filePath).absolutePath;
          const reason = yield* rejectionReason(absolutePath, channel);
          if (reason) {
            return { output: null, error: reason };
          }

          const args: string[] = [];
          if (includeReferenced) {
            args.push('-inc');
          }
          if (yield* hasChinesePackages(absolutePath)) {
            args.push('-ch-only');
          }
          args.push(filePath);

          const { stdout, error } = yield* runTexcount(args, channel, filePath);
          return {
            output: stdout
              ? `TeX Count Results for ${filePath}:\n${stdout}`
              : null,
            error,
          };
        }),
      { concurrency: COUNT_CONCURRENCY },
    );

    return {
      outputs: results.map((result) => result.output).filter(filterNotNull),
      errors: results.map((result) => result.error).filter(filterNotNullish),
    };
  },
);

const getSummedCount = Effect.fn('texcount.getSummedCount')(function* (
  paths: readonly string[],
  channel: string,
) {
  const log = createLog(channel);
  const errors: string[] = [];

  // The per-file probes fan out; the sum itself is a single texcount call
  // over whatever survived, so the results are folded back in input order.
  const screened = yield* Effect.forEach(
    paths,
    (filePath) =>
      Effect.gen(function* () {
        const absolutePath = pathToLocation(filePath).absolutePath;
        const reason = yield* rejectionReason(absolutePath, channel);
        if (reason) return { filePath, reason, chinese: false };
        return {
          filePath,
          reason: null,
          chinese: yield* hasChinesePackages(absolutePath),
        };
      }),
    { concurrency: COUNT_CONCURRENCY },
  );

  const validPaths: string[] = [];
  let enableChineseMode = false;
  for (const entry of screened) {
    if (entry.reason) {
      errors.push(entry.reason);
      continue;
    }
    validPaths.push(entry.filePath);
    if (!enableChineseMode && entry.chinese) {
      enableChineseMode = true;
      log.debug(
        `Chinese packages detected in ${entry.filePath}, enabling Chinese character counting`,
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

  const { stdout, error } = yield* runTexcount(
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
});

export const getTeXCount = Effect.fn('texcount.getTeXCount')(function* (
  filePaths: string | string[],
  { mode = 'separate', channel }: TexcountOptions = {},
): Effect.fn.Return<TexcountResult, never> {
  const resolvedChannel = channel ?? CHANNEL;
  const log = createLog(resolvedChannel);

  const counted = Effect.gen(function* () {
    const trimmedPaths = ensureArray(filePaths)
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0);

    if (trimmedPaths.length === 0) {
      const message = 'No LaTeX files provided for texcount.';
      log.warn(message);
      return { output: null, errors: [message] };
    }

    if (mode === 'sum') {
      const { output, errors } = yield* getSummedCount(
        trimmedPaths,
        resolvedChannel,
      );
      if (output) {
        log.info(`Combined TeX Count Results:\n${output}`);
      }
      return { output, errors };
    }

    const { outputs, errors } = yield* getIndividualCounts(
      trimmedPaths,
      resolvedChannel,
      mode === 'include',
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
  });

  // Every failure below is a counting failure, reported in `errors` rather
  // than raised: a caller asking for a word count wants the partial answer
  // and the reason, not a thrown run.
  return yield* counted.pipe(
    Effect.catch((err) =>
      Effect.sync((): TexcountResult => {
        const errorMessage = `Error in getTeXCount: ${toErrorMessage(err)}`;
        log.error(errorMessage);
        return { output: null, errors: [errorMessage] };
      }),
    ),
  );
});

interface TeXCountStat {
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

export const getTeXCountStats = Effect.fn('texcount.getTeXCountStats')(
  function* (filePaths: string | string[], channel: string = CHANNEL) {
    const { output } = yield* getTeXCount(filePaths, { channel });
    return output
      ? `TeX Count Statistics:<texcount>\n${output}\n</texcount>\n\n`
      : null;
  },
);
