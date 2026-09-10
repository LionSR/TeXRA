import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { filterNotNull, filterNotNullish, ensureArray } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';

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
      Effect.logError(
        `Error checking Chinese packages: ${toErrorMessage(err)}`,
      ).pipe(Effect.as(false)),
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
) {
  const exists = yield* Effect.tryPromise({
    try: () => AbsoluteFS.exists(filePath),
    catch: ensureError,
  });
  if (!exists) {
    const reason = `File ${filePath} does not exist.`;
    yield* Effect.logWarning(reason);
    return reason;
  }

  if (!hasExtension(filePath, '.tex')) {
    const reason = `Error: File ${filePath} is not a LaTeX file. Skipping.`;
    yield* Effect.logWarning(reason);
    return reason;
  }

  return null;
});

/**
 * Invoke `texcount`. The subprocess is cancelled by the fiber's own
 * interruption: `Effect.tryPromise` hands the thunk an `AbortSignal` that
 * aborts when the fiber is interrupted, so no caller threads a signal in.
 *
 * `channel` is still a parameter because `runToolWithCheck` logs the command
 * itself through the Promise-shaped writers; this function's own entries take
 * the channel the whole count was annotated with.
 */
const runTexcount = Effect.fn('texcount.runTexcount')(function* (
  args: string[],
  channel: string,
  context: string,
): Effect.fn.Return<{ stdout: string | null; error?: string }, Error> {
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
    yield* Effect.logDebug(`Successfully counted ${context}`);
    return { stdout: result.stdout };
  }

  yield* Effect.logError(`Error getting tex count for ${context}`);
  if (result.stdout) {
    yield* Effect.logError(`Stdout: ${result.stdout}`);
  }
  if (result.stderr) {
    yield* Effect.logError(`Stderr: ${result.stderr}`);
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
          const reason = yield* rejectionReason(absolutePath);
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
  const errors: string[] = [];

  // The per-file probes fan out; the sum itself is a single texcount call
  // over whatever survived, so the results are folded back in input order.
  const screened = yield* Effect.forEach(
    paths,
    (filePath) =>
      Effect.gen(function* () {
        const absolutePath = pathToLocation(filePath).absolutePath;
        const reason = yield* rejectionReason(absolutePath);
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
      yield* Effect.logDebug(
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

  const counted = Effect.gen(function* () {
    const trimmedPaths = ensureArray(filePaths)
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0);

    if (trimmedPaths.length === 0) {
      const message = 'No LaTeX files provided for texcount.';
      yield* Effect.logWarning(message);
      return { output: null, errors: [message] };
    }

    if (mode === 'sum') {
      const { output, errors } = yield* getSummedCount(
        trimmedPaths,
        resolvedChannel,
      );
      if (output) {
        yield* Effect.logInfo(`Combined TeX Count Results:\n${output}`);
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
    yield* Effect.logInfo(`Combined TeX Count Results:\n${combinedOutput}`);
    return { output: combinedOutput, errors };
  });

  // Every failure below is a counting failure, reported in `errors` rather
  // than raised: a caller asking for a word count wants the partial answer
  // and the reason, not a thrown run.
  return yield* counted.pipe(
    Effect.catch((err) =>
      Effect.suspend(() => {
        const errorMessage = `Error in getTeXCount: ${toErrorMessage(err)}`;
        return Effect.logError(errorMessage).pipe(
          Effect.as<TexcountResult>({ output: null, errors: [errorMessage] }),
        );
      }),
    ),
    // One channel for the whole count: every helper below logs into it
    // instead of taking the channel as a parameter of its own.
    withLogChannel(resolvedChannel),
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
