/**
 * The generated files under a run's storage directory.
 *
 * One walk, two renderings: the agent-facing `/executions/{id}/files` listing
 * in `ExecutionsTool` and the CLI's history detail view both need "what did
 * this run produce", and previously each walked the directory itself. The two
 * walks agreed on depth but disagreed on order, on stat/readDir failure
 * policy, and on how deep they descended — so the same run listed
 * differently depending on who asked.
 *
 * A run's records live in the event table, so everything left in the
 * directory is the run's own output.
 */

import * as path from 'node:path';

import { Effect, FileSystem, type PlatformError } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since the input is a storage-relative path produced by the
// walk below, not raw user input.
import { toPosixPath } from '@utils/core/pathCore';
import { runDirUnder } from '@utils/files/runStorageFs';

const CHANNEL = 'runGeneratedFiles';

/** Scan depth: the run root plus one level of generated subdirectories. */
const RUN_FILE_SCAN_DEPTH = 2;

/** A file or directory a run wrote into its storage directory. */
export interface RunGeneratedFile {
  /** Path relative to the run storage directory, POSIX-separated. */
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

/**
 * List the generated (non-KV) files under a run's storage directory, sorted by
 * path. Returns `[]` when the run has no storage directory at all.
 *
 * `storage` is the session's storage directory (`WorkspaceRoots.storage`),
 * taken as data rather than from an ambient session scope a fiber's
 * continuation may not carry, so a host holding one session per open project
 * walks the storage of the session it names.
 */
export const listRunGeneratedFiles = Effect.fn('listRunGeneratedFiles')(
  function* (
    runId: RunId,
    storage: string,
  ): Effect.fn.Return<
    RunGeneratedFile[],
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const fs = yield* FileSystem.FileSystem;
    const runDir = runDirUnder(storage, runId);
    if (!(yield* fs.exists(runDir))) return [];
    const files = yield* walkRunStorage(runDir, '', RUN_FILE_SCAN_DEPTH);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  },
);

function walkRunStorage(
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Effect.Effect<
  RunGeneratedFile[],
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fullPath = relativePath
      ? path.join(basePath, relativePath)
      : basePath;

    const entries = yield* fs.readDirectory(fullPath).pipe(
      // Deliberately warn-and-continue rather than rethrow: an unreadable
      // subdirectory must not blank out the rest of the listing. A missing
      // directory is the expected "nothing persisted here" case; any other read
      // failure (permissions, corrupt storage) still degrades to empty, but
      // loudly — the warn is the surfacing mechanism, matching the
      // outputDiscovery/externalInquiryStorage fallback precedent.
      // The run directory itself has no rest to keep: its failure propagates
      // rather than reading as "no generated files".
      Effect.catch((error) => {
        if (error.reason._tag === 'NotFound')
          return Effect.succeed<string[]>([]);
        if (relativePath === '') return Effect.fail(error);
        return Effect.logWarning(
          `Unreadable run directory '${fullPath}'; listing it as empty`,
        ).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
          Effect.as<string[]>([]),
        );
      }),
    );

    // Each entry is read concurrently; the caller sorts the listing.
    const perEntry = yield* Effect.forEach(
      entries,
      (name) =>
        Effect.gen(function* () {
          const rawRelative = relativePath
            ? path.join(relativePath, name)
            : name;
          const childPath = path.join(basePath, rawRelative);

          const stat = yield* fs.stat(childPath).pipe(
            // An entry that vanished, or whose path stopped naming something a
            // stat can follow, between the listing and the stat is a benign race;
            // anything else is a real fault and propagates.
            Effect.catchIf(
              (error) =>
                error.reason._tag === 'NotFound' ||
                error.reason._tag === 'BadResource',
              () => Effect.void,
            ),
          );
          if (!stat) return [];

          // The entry's kind comes from the stat that already ran, which follows
          // a symlink to what it points at — the classification the listing this
          // replaced made from its own symlink-following type bits.
          const entryIsDirectory = stat.type === 'Directory';
          const entry: RunGeneratedFile = {
            path: toPosixPath(rawRelative),
            size: Number(stat.size),
            isDirectory: entryIsDirectory,
          };
          if (!entryIsDirectory || maxDepth <= 1) return [entry];
          return [
            entry,
            ...(yield* walkRunStorage(basePath, rawRelative, maxDepth - 1)),
          ];
        }),
      { concurrency: 8 },
    );
    return perEntry.flat();
  });
}
