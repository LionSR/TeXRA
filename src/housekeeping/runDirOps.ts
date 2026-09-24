// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { RunId, FileOpResult } from '@shared/schemas';
import {
  getCleanAgentName,
  mergeRunDirAndWorkspaceResult,
} from '@shared/schemas';
import { resolveRunStoragePath } from '@utils/files/runStorageFs';
import { copyDereferenced } from '@utils/files/fsDurability';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

// Local file imports
import { CHANNEL, HISTORY_DIR } from './constants';
import { runPackMultiple, runPackSingle } from './pack';
import { asErrorResult, generateTimestamp } from './utils';

/**
 * Whether the run directory exists, by a `stat` whose only absent answer is
 * `NotFound`: a directory that cannot be inspected (permissions, I/O) fails,
 * and the failure reaches {@link asErrorResult} instead of reading as "no
 * files" — the rule the storage-root `exists` this replaces followed.
 */
const runDirExists = (storageFs: RootedFileSystem, runDirRelative: string) =>
  storageFs.stat(runDirRelative).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(false),
    ),
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
const runPackRunDir = Effect.fn('housekeeping.runPackRunDir')(function* (
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

/**
 * The Pack action both hosts run: the source document's own files (its PDF)
 * are copied into `History/` and its build artifacts swept, together with
 * any extra `outputFiles`; when a run is named, that run's storage is
 * snapshotted beside them and the two results merged. The host only presents
 * the result.
 */
export const packRunOutputs = Effect.fn('housekeeping.packRunOutputs')(
  function* (request: {
    readonly agent: string;
    readonly model: string;
    readonly inputFile: string;
    readonly outputFiles: string[];
    readonly runId?: RunId;
  }) {
    const { agent, model, inputFile, outputFiles, runId } = request;
    const packWorkspace =
      outputFiles.length > 0
        ? runPackMultiple(model, inputFile, agent, outputFiles)
        : runPackSingle(model, inputFile, agent);
    if (!runId) return yield* packWorkspace;
    return mergeRunDirAndWorkspaceResult(
      yield* runPackRunDir(runId, agent, model, inputFile),
      yield* packWorkspace,
    );
  },
);
