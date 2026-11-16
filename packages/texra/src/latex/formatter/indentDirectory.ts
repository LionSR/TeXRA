import * as path from 'node:path';

import { Effect, FileSystem, Path, PlatformError } from 'effect';

import { hasExtension } from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  readDirectoryTypedTolerant,
  entryTypeIn,
} from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { FILE_HANDLING_RULES } from '@texra/common/files/fileHandlingRules';

import type { ToolMissing } from '@texra/utils/system/toolChecks';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';
import { LatexProgress } from '../progress';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { LatexFormatter } from './texFormatter';

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(
  FILE_HANDLING_RULES.ignored.bulkOperationDirectories,
);

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

  // One entry whose type cannot be read must not cost the whole directory;
  // the tolerant listing drops that entry instead.
  const walkDirectory = Effect.fn('latex.indentWalkDirectory')(function* (
    dirPath: string,
  ): Effect.fn.Return<
    void,
    PlatformError.PlatformError | ToolMissing,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const entries = yield* readDirectoryTypedTolerant(dirPath);
    for (const [name, type] of entries) {
      if (SKIPPED_DIRECTORIES.has(name.toLowerCase())) {
        continue;
      }

      // Skip symlinks to avoid cycles; we have no realpath/visited guard.
      if (type === 'SymbolicLink') {
        continue;
      }

      const fullPath = path.join(dirPath, name);

      if (type === 'Directory') {
        yield* walkDirectory(fullPath);
        continue;
      }

      if (type !== 'File' || !hasExtension(name, '.tex')) {
        continue;
      }

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
    }
  });

  const absoluteDirectory = path.isAbsolute(directory)
    ? directory
    : path.resolve(workspaceRoot ?? '.', directory);

  return yield* walkDirectory(absoluteDirectory).pipe(
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
