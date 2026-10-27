import { Effect, FileSystem, Predicate, Array as Arr } from 'effect';

import {
  withLogChannel,
  hasExtension,
  pathToLocationIn,
} from '@texra-ai/harness';
import { pathExists, readNormalizedFile } from '@texra-ai/harness/node';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { runToolWithCheck } from '@texra/utils/system/toolChecks';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { SettingsStores } from '@texra-ai/harness';

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
  const fs = yield* FileSystem.FileSystem;
  return yield* readNormalizedFile(fs, absolutePath).pipe(
    Effect.mapError(ensureError),
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

export type TexcountMode = 'separate' | 'include';

export interface TexcountOptions {
  mode?: TexcountMode;
  /**
   * Setting slots of the counted workspace, held as data by the caller that
   * asked (a tool call's roots, a run's session roots, the host command's),
   * so the spawn names this project's settings rather than an ambient one.
   */
  settings: SettingsStores;
}

interface TexcountResult {
  output: string | null;
  errors: string[];
}

/** Returns why the file cannot be counted, or null when it is countable. */
const rejectionReason = Effect.fn('texcount.rejectionReason')(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* pathExists(fs, filePath).pipe(
    Effect.mapError(ensureError),
  );
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
 * interruption, which `runToolWithCheck` carries into the spawn, so no caller
 * threads a signal in.
 */
const runTexcount = Effect.fn('texcount.runTexcount')(function* (
  workspaceRoot: string | undefined,
  settings: SettingsStores,
  args: string[],
  context: string,
): Effect.fn.Return<
  { stdout: string | null; error?: string },
  Error,
  ChildProcessSpawner
> {
  const result = yield* runToolWithCheck('texcount', args, {
    channel: CHANNEL,
    // The file arguments are workspace-relative, so the root the caller
    // counted for is also the directory texcount resolves them against.
    cwd: workspaceRoot,
    settings,
    showError: true,
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
    workspaceRoot: string | undefined,
    settings: SettingsStores,
    paths: readonly string[],
    includeReferenced: boolean,
  ) {
    const results = yield* Effect.forEach(
      paths,
      (filePath) =>
        Effect.gen(function* () {
          const absolutePath = pathToLocationIn(
            workspaceRoot,
            filePath,
          ).absolutePath;
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

          const { stdout, error } = yield* runTexcount(
            workspaceRoot,
            settings,
            args,
            filePath,
          );
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
      outputs: results
        .map((result) => result.output)
        .filter(Predicate.isNotNull),
      errors: results
        .map((result) => result.error)
        .filter(Predicate.isNotNullish),
    };
  },
);

export const getTeXCount = Effect.fn('texcount.getTeXCount')(function* (
  workspaceRoot: string | undefined,
  filePaths: string | string[],
  { mode = 'separate', settings }: TexcountOptions,
): Effect.fn.Return<
  TexcountResult,
  never,
  FileSystem.FileSystem | ChildProcessSpawner
> {
  const counted = Effect.gen(function* () {
    const trimmedPaths = Arr.ensure(filePaths)
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0);

    if (trimmedPaths.length === 0) {
      const message = 'No LaTeX files provided for texcount.';
      yield* Effect.logWarning(message);
      return { output: null, errors: [message] };
    }

    const { outputs, errors } = yield* getIndividualCounts(
      workspaceRoot,
      settings,
      trimmedPaths,
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
    withLogChannel(CHANNEL),
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
  }).filter(Predicate.isNotNull);
}

export const getTeXCountStats = Effect.fn('texcount.getTeXCountStats')(
  function* (
    workspaceRoot: string | undefined,
    settings: SettingsStores,
    filePaths: string | string[],
  ) {
    const { output } = yield* getTeXCount(workspaceRoot, filePaths, {
      settings,
    });
    return output
      ? `TeX Count Statistics:<texcount>\n${output}\n</texcount>\n\n`
      : null;
  },
);
