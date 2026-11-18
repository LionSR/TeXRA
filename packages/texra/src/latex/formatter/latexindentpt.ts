import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { meansAbsent, entryTypeIn } from '@texra-ai/harness/node';
import { removeBestEffort } from '@texra/common/files/removeBestEffort';
import { runTool } from '@texra/utils/system/toolChecks';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';

/**
 * The files in `dir` whose names start with one of `prefixes`, found by a
 * plain name prefix over one listing so a path holding glob metacharacters
 * (or a Windows backslash) still names its own files. Directories are left
 * out, as glob's nodir did: a non-recursive remove of an empty directory
 * would succeed (rmdir) and delete it. An absent `dir` lists nothing; any
 * other listing failure is warned about and lists nothing too.
 */
const filesByPrefix = Effect.fn('latex.filesByPrefix')(function* (
  dir: string,
  prefixes: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs
    .readDirectory(dir)
    .pipe(
      Effect.catch((error) =>
        meansAbsent(error)
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.logWarning(`Failed to list ${dir}`).pipe(
              Effect.annotateLogs({ data: error }),
              Effect.as<ReadonlyArray<string>>([]),
            ),
      ),
    );
  return yield* Effect.filter(
    names
      .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
      .map((name) => path.join(dir, name)),
    (candidate) =>
      entryTypeIn(fs, candidate).pipe(
        Effect.map((type) => type !== undefined && type !== 'Directory'),
        // An entry that cannot be typed is still offered to the remove,
        // which reports its own failure.
        Effect.catch(() => Effect.succeed(true)),
      ),
  );
});

/**
 * `workspaceRoot` is the root a relative `filePath` resolves against and the
 * cwd latexindent runs in, and `latexindentConfig` the configured config-file
 * path — the caller's own session root and configuration, held as data, not
 * the roots the calling fiber happens to carry.
 */
export const runLatexIndent = Effect.fn('latex.runLatexIndent')(function* (
  filePath: string,
  workspaceRoot: string | undefined,
  latexindentConfig: string,
) {
  // Resolve workspace-relative paths to absolute so cleanup works correctly.
  // Some callers (latexCommands, housekeeping/indent) pass relative paths.
  const absolutePath =
    path.isAbsolute(filePath) || !workspaceRoot
      ? filePath
      : path.join(workspaceRoot, filePath);

  const args = ['-w', '-s'];
  if (latexindentConfig) {
    args.push(`-l=${latexindentConfig}`);
  }
  args.push(absolutePath);

  // A missing latexindent is the caller's `ToolMissing`: it never started, so
  // it left no backup or log to clean up.
  const { success } = yield* runTool('latexindent', args, {
    cwd: workspaceRoot,
  });

  // Always clean up the `<base>.tex.bak*` and `<base>.bak*` backups —
  // latexindent creates them before modifying, so a crash or failure can
  // still leave orphaned backups — and its indent.log, which it may also
  // write at the process cwd (the workspace root).
  const fs = yield* FileSystem.FileSystem;
  const fileBaseName = path.basename(absolutePath, '.tex');
  const fileDir = path.dirname(absolutePath);
  const backupFiles = yield* filesByPrefix(fileDir, [
    `${fileBaseName}.tex.bak`,
    `${fileBaseName}.bak`,
  ]);
  yield* removeBestEffort(fs, backupFiles, 'backup file');
  yield* removeBestEffort(
    fs,
    workspaceRoot && fileDir !== workspaceRoot
      ? [
          path.join(fileDir, 'indent.log'),
          path.join(workspaceRoot, 'indent.log'),
        ]
      : [path.join(fileDir, 'indent.log')],
    'latexindent log',
  );

  if (success) {
    yield* Effect.logInfo(`Indented ${absolutePath}`);
  }
  return success;
}, withLogChannel(CHANNEL));
