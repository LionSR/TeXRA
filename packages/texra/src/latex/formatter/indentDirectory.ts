import * as path from 'node:path';

import {
  Array as Arr,
  Effect,
  FileSystem,
  Path,
  PlatformError,
  Result,
} from 'effect';

import { withLogChannel } from '@texra-ai/worldline/plugins';
import { entryTypeIn } from '@texra-ai/worldline/node';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
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
  | { status: 'disabled' }
  | { status: 'missing-config'; configPath: string }
  | { status: 'error'; error: unknown };

/**
 * Formats LaTeX files in a directory and its subdirectories
 * @param workspaceRoot The cwd the formatter runs in, held by the caller as
 * data.
 * @param formatter The resolved formatter, or null when formatting is disabled.
 * The caller resolves it from its own workspace configuration
 * (`resolveLatexFormatter(roots)`), so this never reads the roots the
 * calling fiber happens to carry.
 * @param directory The absolute directory to process.
 * @returns The formatting outcome
 */
export const indentLatexFilesInDirectory = Effect.fn(
  'latex.indentLatexFilesInDirectory',
)(function* (
  workspaceRoot: string,
  formatter: LatexFormatter | null,
  directory: string,
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
    return { status: 'disabled' };
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
    return { status: 'missing-config', configPath: config };
  }

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
      return Result.succeed(fullPath);
    }
    yield* Effect.logError(`Failed to format ${fullPath}`).pipe(
      withLogChannel(CHANNEL),
    );
    return Result.fail(fullPath);
  });

  // The formatter rewrites what the walk finds, so links are skipped: it
  // never formats a file outside the directory it was given.
  return yield* listWorkspaceFiles({
    root: directory,
    configs: [TEX_SOURCES],
    links: 'skip',
  }).pipe(
    Effect.flatMap(([{ files }]) =>
      Effect.forEach(files, (file) => formatFile(path.join(directory, file))),
    ),
    Effect.flatMap((outcomes) => {
      const [indented, failed] = Arr.separate(outcomes);
      return Effect.logInfo(
        `${indented.length} .tex files have been formatted in ${directory}`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.as<IndentLatexResult>({
          status: 'formatted',
          count: indented.length,
          failed,
        }),
      );
    }),
    Effect.catch((err) =>
      Effect.logError(
        `Error during indentation process: ${toErrorMessage(err)}`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.as({ status: 'error', error: err } satisfies IndentLatexResult),
      ),
    ),
  );
});
