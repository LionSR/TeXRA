// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel, withLogData } from '@logger/effectLog';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { RunId, FileOpResult } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas';
import { copyDereferenced } from '@utils/files/fsDurability';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { CHANNEL, HISTORY_DIR } from './constants';
import { generateTimestamp } from './utils';

/**
 * Whether the run directory exists, by a `stat` whose only absent answer is
 * `NotFound`: a directory that cannot be inspected (permissions, I/O) fails,
 * and the failure reaches {@link asErrorResult} instead of reading as "no
 * files" — the rule the `StorageFS.exists` this replaces followed.
 */
const runDirExists = (storageFs: RootedFileSystem, runDirRelative: string) =>
  storageFs.stat(runDirRelative).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(false),
    ),
  );

/** Every run-directory failure reaches the host as the same result shape. */
const asErrorResult = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`).pipe(
    withLogData(error),
    withLogChannel(CHANNEL),
    Effect.as<FileOpResult>({ status: 'error', error: toErrorMessage(error) }),
  );

/**
 * Snapshot a completed run's runDir into `workspace/History/`. Symlinks
 * are dereferenced so the snapshot is a self-contained copy.
 *
 * The two roots are two services: the run directory is resolved and vouched
 * for by the session's storage filesystem, the destination by its workspace
 * filesystem, and the copy between them names only the two absolute paths
 * each root produced.
 */
export const runPackRunDir = Effect.fn('housekeeping.runPackRunDir')(function* (
  runId: RunId,
  agent: string,
  model: string,
  inputFile: string,
) {
  yield* Effect.logInfo(
    `Packing runDir for run ${runId} (agent=${agent}, model=${model}, inputFile=${inputFile})`,
  ).pipe(withLogChannel(CHANNEL));

  const storageFs = yield* StorageFs;
  const workspaceFs = yield* WorkspaceFs;

  return yield* Effect.gen(function* () {
    const runDirRelative = resolveRunStoragePath(runId);
    if (!(yield* runDirExists(storageFs, runDirRelative))) {
      yield* Effect.logWarning(`Run directory not found for run ${runId}`).pipe(
        withLogChannel(CHANNEL),
      );
      return { status: 'noFiles' } satisfies FileOpResult;
    }

    const baseName = inputFile ? path.parse(inputFile).name : 'run';
    const cleanAgent = getCleanAgentName(agent);
    // Include a runId fragment in the destination folder so two packs of
    // the same input+agent+model within the same second (the timestamp's
    // granularity) don't collide and silently merge.
    const idFragment = runId.replaceAll('-', '').slice(0, 8);
    const destinationRelative = path.join(
      HISTORY_DIR,
      `${generateTimestamp()}_${baseName}_${cleanAgent}_${model}_${idFragment}`,
    );

    const source = yield* storageFs.resolve(runDirRelative);
    const destination = yield* workspaceFs.resolve(destinationRelative);
    yield* workspaceFs.makeDirectory(destinationRelative, {
      recursive: true,
    });
    yield* copyDereferenced(source, destination, { overwrite: true });
    yield* Effect.logInfo(`Packed runDir ${source} -> ${destination}`).pipe(
      withLogChannel(CHANNEL),
    );
    return {
      status: 'success',
      outputFolder: destinationRelative,
    } satisfies FileOpResult;
  }).pipe(Effect.catch(asErrorResult('Pack runDir')));
});

/**
 * Delete a run's runDir. Irreversible. Used when the user discards a run
 * from the progress-view toolbar.
 */
export const runCleanRunDir = Effect.fn('housekeeping.runCleanRunDir')(
  function* (runId: RunId) {
    const storageFs = yield* StorageFs;

    return yield* Effect.gen(function* () {
      const runDirRelative = resolveRunStoragePath(runId);
      if (!(yield* runDirExists(storageFs, runDirRelative))) {
        yield* Effect.logWarning(
          `Run directory not found for run ${runId}`,
        ).pipe(withLogChannel(CHANNEL));
        return { status: 'noFiles' } satisfies FileOpResult;
      }

      yield* Effect.logInfo(
        `Removing runDir for run ${runId}: ${runDirRelative}`,
      ).pipe(withLogChannel(CHANNEL));
      yield* storageFs.remove(runDirRelative, {
        recursive: true,
        force: true,
      });
      return { status: 'success' } satisfies FileOpResult;
    }).pipe(Effect.catch(asErrorResult('Clean runDir')));
  },
);
