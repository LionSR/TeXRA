import * as path from 'node:path';

import { Effect, FileSystem, Path, PlatformError } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { FILE_HANDLING_RULES } from '@texra/common/files/fileHandlingRules';
import type { FileFilterConfig } from '@texra/common/files/fileListingRules';
import { listWorkspaceFiles } from '@texra/common/files/workspaceFileListing';

import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';
import { LatexProgress } from '../progress';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { LatexFormatter } from './texFormatter';

/** Every `.tex` file outside the directories bulk operations skip. */
const TEX_SOURCES: FileFilterConfig = {
  include: ['.tex'],
  excludeExtensions: [],
  excludeDirs: [...FILE_HANDLING_RULES.ignored.bulkOperationDirectories],
  excludeKeywords: [],
  excludeFiles: [],
};

export type IndentLatexResult =
  | {
      status: 'formatted';
      count: number;
      /** The `.tex` files the formatter ran on and failed. */
      failed: readonly string[];
    }
  | {
      status: 'disabled';
      count: 0;
    }
  | {
      status: 'missing-config';
      count: 0;
      configPath: string;
    }
  | {
      status: 'error';
      count: 0;
      error: unknown;
    };

/**
 * Formats LaTeX files in a specific directory and its subdirectories
 * @param workspaceRoot Root a relative `directory` resolves against and the cwd
 * the formatter runs in, held by the caller as data. When `undefined`, a
 * relative `directory` resolves against the process cwd.
 * @param formatter The resolved formatter, or null when formatting is disabled.
 * The caller resolves it from its own workspace configuration
 * (`resolveLatexFormatter(roots)`), so this never reads the roots the
 * calling fiber happens to carry.
 * @param directory The directory to process (relative to workspace). If not provided, uses the root.
 * @returns The formatting outcome
 */
export const indentLatexFilesInDirectory = Effect.fn(
  'latex.indentLatexFilesInDirectory',
)(function* (
  workspaceRoot: string | undefined,
  formatter: LatexFormatter | null,
  directory: string = '.',
): Effect.fn.Return<
  IndentLatexResult,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  yield* Effect.logDebug(
    `Starting LaTeX indentation process for directory: ${directory}`,
  ).pipe(withLogChannel(CHANNEL));

  if (!formatter) {
    yield* Effect.logDebug(
      'LaTeX formatter disabled; skipping indentation',
    ).pipe(withLogChannel(CHANNEL));
    return { status: 'disabled', count: 0 };
  }
  const { id, configPath: config, run: runFormatter } = formatter;
  yield* Effect.logDebug(`Formatter: ${id}, Config: ${config}`).pipe(
    withLogChannel(CHANNEL),
  );
  const progress = yield* LatexProgress;

  const fs = yield* FileSystem.FileSystem;
  if (config && (yield* entryTypeIn(fs, config)) === undefined) {
    yield* Effect.logError(`Formatter config file not found at ${config}`).pipe(
      withLogChannel(CHANNEL),
    );
    return {
      status: 'missing-config',
      count: 0,
      configPath: config,
    };
  }

  let indentedCount = 0;
  const failed: string[] = [];

  const formatFile = Effect.fn('latex.indentFile')(function* (
    fullPath: string,
  ) {
    progress(`Indenting ${path.basename(fullPath)}...`, 0);
    yield* Effect.logDebug(`Processing file: ${fullPath}`).pipe(
      withLogChannel(CHANNEL),
    );

    // A failed run is `false`. A missing formatter fails the walk with its
    // `ToolMissing`, once, rather than once per file.
    if (yield* runFormatter(fullPath, workspaceRoot, config)) {
      yield* Effect.logInfo(`Successfully formatted: ${fullPath}`).pipe(
        withLogChannel(CHANNEL),
      );
      indentedCount++;
    } else {
      yield* Effect.logError(`Failed to format ${fullPath}`).pipe(
        withLogChannel(CHANNEL),
      );
      failed.push(fullPath);
    }
  });

  const absoluteDirectory = path.resolve(workspaceRoot ?? '.', directory);

  // The formatter rewrites what the walk finds, so links are skipped: it
  // never formats a file outside the directory it was given.
  return yield* listWorkspaceFiles({
    root: absoluteDirectory,
    configs: [TEX_SOURCES],
    links: 'skip',
  }).pipe(
    Effect.flatMap(([{ files }]) =>
      Effect.forEach(
        files,
        (file) => formatFile(path.join(absoluteDirectory, file)),
        { discard: true },
      ),
    ),
    Effect.andThen(() =>
      Effect.logInfo(
        `${indentedCount} .tex files have been formatted in ${directory}`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.as<IndentLatexResult>({
          status: 'formatted',
          count: indentedCount,
          failed,
        }),
      ),
    ),
    Effect.catch((err) =>
      Effect.logError(
        `Error during indentation process: ${toErrorMessage(err)}`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.as({
          status: 'error',
          count: 0,
          error: err,
        } satisfies IndentLatexResult),
      ),
    ),
  );
});
