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

import { Effect } from 'effect';

import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { hostPort } from '@common/hostPort';
import { createLog } from '@logger/logUtils';
import type { RunId } from '@shared/schemas';
import { byStringProp } from '@utils/core';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since the input is a storage-relative path produced by the
// walk below, not raw user input.
import { toPosixPath } from '@utils/core/pathCore';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/runStorageFs';
import { StorageFS } from '@utils/files/storageFS';

const log = createLog('runGeneratedFiles');

/** Scan depth: the run root plus one level of generated subdirectories. */
const RUN_FILE_SCAN_DEPTH = 2;

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
 * Every storage read runs in `session`'s scope: `StorageFS` resolves its root
 * from the ambient session, and a fiber's continuation carries no caller's
 * scope, so a host holding one session per open paper would otherwise walk the
 * wrong root.
 */
export const listRunGeneratedFiles = Effect.fn('listRunGeneratedFiles')(
  function* (
    runId: RunId,
    session: SessionHandle,
  ): Effect.fn.Return<RunGeneratedFile[], unknown> {
    const runDir = yield* hostPort(() =>
      runInSession(session, () => findExistingRunStoragePath(runId)),
    );
    if (!runDir) return [];
    const files = yield* walkRunStorage(
      session,
      runDir,
      '',
      RUN_FILE_SCAN_DEPTH,
    );
    return files.sort(byStringProp((file) => file.path));
  },
);

function walkRunStorage(
  session: SessionHandle,
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Effect.Effect<RunGeneratedFile[], unknown> {
  return Effect.gen(function* () {
    const fullPath = relativePath
      ? path.join(basePath, relativePath)
      : basePath;

    const entries = yield* hostPort(() =>
      runInSession(session, () => StorageFS.readDir(fullPath)),
    ).pipe(
      // Deliberately warn-and-continue rather than rethrow: an unreadable
      // subdirectory must not blank out the rest of the listing. A missing
      // directory is the expected "nothing persisted here" case; any other read
      // failure (permissions, corrupt storage) still degrades to empty, but
      // loudly — the warn is the surfacing mechanism, matching the
      // outputDiscovery/externalInquiryStorage fallback precedent (#10630).
      Effect.catch((error) =>
        Effect.sync((): [string, number][] => {
          if (!isFileNotFoundError(error)) {
            log.warn(
              `Unreadable run directory '${fullPath}'; listing it as empty`,
              { data: error },
            );
          }
          return [];
        }),
      ),
    );

    const files: RunGeneratedFile[] = [];
    for (const [name, type] of entries) {
      const rawRelative = relativePath ? path.join(relativePath, name) : name;
      const childPath = path.join(basePath, rawRelative);
      const entryIsDirectory = isDirectory(type);

      const stat = yield* hostPort(() =>
        runInSession(session, () => StorageFS.stat(childPath)),
      ).pipe(
        // An entry that vanished (or whose parent stopped being a directory)
        // between readDir and stat is a benign race; anything else is a real
        // fault and propagates.
        Effect.catch((error) =>
          isFileNotFoundError(error) || isNotADirectoryError(error)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
      if (!stat) continue;

      files.push({
        path: toPosixPath(rawRelative),
        size: stat.size,
        isDirectory: entryIsDirectory,
      });

      if (entryIsDirectory && maxDepth > 1) {
        files.push(
          ...(yield* walkRunStorage(
            session,
            basePath,
            rawRelative,
            maxDepth - 1,
          )),
        );
      }
    }
    return files;
  });
}
