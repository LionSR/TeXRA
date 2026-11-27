import { Array as Arr, Effect, FileSystem, Result } from 'effect';

import { isLatexFile } from '@texra/shared/latexFileTypes';
import { pathExists } from '@texra-ai/worldline/node';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
import { runTool } from '@texra/utils/system/toolChecks';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';
import {
  documentClass,
  loadedPackages,
  readUncommentedLatex,
} from './latexParsingUtils';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { withLogChannel, pathToLocationIn } from '@texra-ai/worldline/plugins';

const CHINESE_PACKAGES = [
  'xeCJK',
  'ctexart',
  'ctex',
  'CJK',
  'ctexrep',
  'ctexbook',
];

const hasChinesePackages = Effect.fn('texcount.hasChinesePackages')(function* (
  absolutePath: string,
) {
  return yield* readUncommentedLatex(absolutePath).pipe(
    Effect.map((content) =>
      [...loadedPackages(content), documentClass(content)].some(
        (name) => name !== undefined && CHINESE_PACKAGES.includes(name),
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

/** Returns why the file cannot be counted, or null when it is countable. */
const rejectionReason = Effect.fn('texcount.rejectionReason')(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* pathExists(fs, filePath);
  if (!exists) {
    const reason = `File ${filePath} does not exist.`;
    yield* Effect.logWarning(reason);
    return reason;
  }

  if (!isLatexFile(filePath)) {
    const reason = `Error: File ${filePath} is not a LaTeX file. Skipping.`;
    yield* Effect.logWarning(reason);
    return reason;
  }

  return null;
});

/**
 * Count the words in one workspace-relative LaTeX file with `texcount`,
 * succeeding with texcount's raw report or failing with the sentence to show.
 * The subprocess is cancelled by the fiber's own interruption, which
 * `runTool` carries into the spawn, so no caller threads a signal in.
 */
export const getTeXCount = Effect.fn('texcount.getTeXCount')(function* (
  workspaceRoot: string | undefined,
  filePath: string,
  mode: TexcountMode,
): Effect.fn.Return<
  Result.Result<string, string>,
  never,
  FileSystem.FileSystem | ChildProcessSpawner
> {
  const counted = Effect.gen(function* () {
    const absolutePath = pathToLocationIn(workspaceRoot, filePath).absolutePath;
    const reason = yield* rejectionReason(absolutePath);
    if (reason) {
      return Result.fail(reason);
    }

    const args: string[] = [];
    if (mode === 'include') {
      args.push('-inc');
    }
    if (yield* hasChinesePackages(absolutePath)) {
      args.push('-ch-only');
    }
    args.push(filePath);

    const result = yield* runTool('texcount', args, {
      // The file argument is workspace-relative, so the root the caller
      // counted for is also the directory texcount resolves it against.
      cwd: workspaceRoot,
    });

    if (result.success && result.stdout) {
      yield* Effect.logInfo(
        `TeX Count Results for ${filePath}:\n${result.stdout}`,
      );
      return Result.succeed(result.stdout);
    }

    yield* Effect.logError(`Error getting tex count for ${filePath}`);
    if (result.stdout) {
      yield* Effect.logError(`Stdout: ${result.stdout}`);
    }
    if (result.stderr) {
      yield* Effect.logError(`Stderr: ${result.stderr}`);
    }
    return Result.fail(
      `texcount failed while processing ${filePath}.` +
        (result.stderr ? ` Details: ${result.stderr}` : ''),
    );
  });

  // Every failure below is a counting failure, returned rather than raised:
  // a caller asking for a word count wants the reason, not a thrown run.
  return yield* counted.pipe(
    Effect.catch((err) =>
      Effect.suspend(() => {
        const errorMessage = `Error in getTeXCount: ${toErrorMessage(err)}`;
        return Effect.logError(errorMessage).pipe(
          Effect.as(Result.fail(errorMessage)),
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
  return Arr.filterMap(TEXCOUNT_STAT_PATTERNS, ([pattern, template]) => {
    const match = output.match(pattern);
    return match
      ? Result.succeed({ label: template.replace('$1', match[1]) })
      : Result.failVoid;
  });
}
