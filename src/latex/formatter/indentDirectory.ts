import * as path from 'node:path';

import { Effect, FileSystem, Path, PlatformError } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { EXCLUDED_DIRS } from '@shared/constants/latexTiming';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readDirectoryTypedTolerant } from '@utils/files/fsDurability';
import { entryExists } from '@utils/files/fsEntryExists';
import { hasExtension } from '@utils/core/pathCore';

import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import type { LatexFormatter } from './texFormatter';

export type IndentLatexResult =
  | {
      status: 'formatted';
      directory: string;
      count: number;
    }
  | {
      status: 'disabled';
      directory: string;
      count: 0;
    }
  | {
      status: 'missing-config';
      directory: string;
      count: 0;
      configPath: string;
    }
  | {
      status: 'error';
      directory: string;
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
 * @param progressCallback Optional callback for progress updates
 * @returns The formatting outcome
 */
export const indentLatexFilesInDirectory = Effect.fn(
  'latex.indentLatexFilesInDirectory',
)(function* (
  workspaceRoot: string | undefined,
  formatter: LatexFormatter | null,
  directory: string = '.',
  progressCallback?: (message: string, increment?: number) => void,
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
    return { status: 'disabled', directory, count: 0 };
  }
  const {
    id,
    configPath: config,
    run: runFormatter,
    settings: formatterSettings,
  } = formatter;
  yield* Effect.logDebug(`Formatter: ${id}, Config: ${config}`).pipe(
    withLogChannel(CHANNEL),
  );

  const fs = yield* FileSystem.FileSystem;
  if (config && !(yield* entryExists(fs, config))) {
    yield* Effect.logError(`Formatter config file not found at ${config}`).pipe(
      withLogChannel(CHANNEL),
    );
    return {
      status: 'missing-config',
      directory,
      count: 0,
      configPath: config,
    };
  }

  let indentedCount = 0;

  // The tolerant listing is the facade's `readDir`: its provider typed each
  // entry from the `readdir` dirent, so one entry whose type could not be read
  // never cost the whole directory.
  const walkDirectory = Effect.fn('latex.indentWalkDirectory')(function* (
    dirPath: string,
  ): Effect.fn.Return<
    void,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const entries = yield* readDirectoryTypedTolerant(dirPath);
    for (const [name, type] of entries) {
      if (EXCLUDED_DIRS.has(name.toLowerCase()) || name.includes('Diffs')) {
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

      progressCallback?.(`Indenting ${path.basename(fullPath)}...`, 0);
      yield* Effect.logDebug(`Processing file: ${fullPath}`).pipe(
        withLogChannel(CHANNEL),
      );

      // Both formatters report a failed run as `false`, so a per-file
      // recovery here would have nothing left to catch.
      if (
        yield* runFormatter(fullPath, workspaceRoot, config, formatterSettings)
      ) {
        yield* Effect.logInfo(`Successfully formatted: ${fullPath}`).pipe(
          withLogChannel(CHANNEL),
        );
        indentedCount++;
      } else {
        yield* Effect.logError(`Failed to format ${fullPath}`).pipe(
          withLogChannel(CHANNEL),
        );
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
          directory,
          count: indentedCount,
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
          directory,
          count: 0,
          error: err,
        } satisfies IndentLatexResult),
      ),
    ),
  );
});
