// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { RunId, FileOpResult } from '@shared/schemas';
import { agentFileName } from '@shared/schemas';
import { modelFileName } from '@shared/constants/workflowOutput';
import { resolveRunStoragePath } from '@utils/files/runStorageFs';
import { copyDereferenced } from '@utils/files/fsDurability';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

// Local file imports
import { CHANNEL, HISTORY_DIR } from './constants';
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
 * The Pack action both hosts run: snapshot a completed run's runDir into
 * `workspace/History/`. Symlinks are dereferenced so the snapshot is a
 * self-contained copy. The workspace's own files are the user's and are
 * never moved or deleted by a pack.
 *
 * The two roots are two services: the run directory is resolved and vouched
 * for by the session's storage filesystem, the destination by its workspace
 * filesystem, and the copy between them names only the two absolute paths
 * each root produced.
 */
export const packRunOutputs = Effect.fn('housekeeping.packRunOutputs')(
  function* ({
    runId,
    agent,
    model,
    inputFile,
  }: {
    readonly runId: RunId;
    readonly agent: string;
    readonly model: string;
    readonly inputFile: string;
  }) {
    yield* Effect.logInfo(
      `Packing runDir for run ${runId} (agent=${agent}, model=${model}, inputFile=${inputFile})`,
    ).pipe(withLogChannel(CHANNEL));

    const storageFs = yield* StorageFs;
    const workspaceFs = yield* WorkspaceFs;

    return yield* Effect.gen(function* () {
      const runDirRelative = resolveRunStoragePath(runId);
      if (!(yield* runDirExists(storageFs, runDirRelative))) {
        yield* Effect.logWarning(
          `Run directory not found for run ${runId}`,
        ).pipe(withLogChannel(CHANNEL));
        return { status: 'noFiles' } satisfies FileOpResult;
      }

      const baseName = inputFile ? path.parse(inputFile).name : 'run';
      const cleanAgent = agentFileName(agent);
      // Include a runId fragment in the destination folder so two runs packed
      // within the same second (the timestamp's granularity) don't collide.
      const idFragment = runId.replaceAll('-', '').slice(0, 8);
      const destinationRelative = path.join(
        HISTORY_DIR,
        `${generateTimestamp()}_${baseName}_${cleanAgent}_${modelFileName(model)}_${idFragment}`,
      );

      const source = yield* storageFs.resolve(runDirRelative);
      const destination = yield* workspaceFs.resolve(destinationRelative);
      yield* workspaceFs.makeDirectory(HISTORY_DIR, { recursive: true });
      // The copy creates the folder and fails on an existing one, so a
      // second pack of the same run within that second reports an error
      // instead of merging into the first snapshot.
      yield* copyDereferenced(source, destination);
      yield* Effect.logInfo(`Packed runDir ${source} -> ${destination}`).pipe(
        withLogChannel(CHANNEL),
      );
      return {
        status: 'success',
        outputFolder: destinationRelative,
      } satisfies FileOpResult;
    }).pipe(Effect.catch(asErrorResult('Pack runDir')));
  },
);

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

/** What a host tells the user after a pack or clean, at which severity.
 *  Both hosts read it from here, so the wording cannot drift between them
 *  (the latexdiff pack's counterpart is `latexdiffPackMessage`). */
export function fileOpResultMessage(
  operation: 'pack' | 'clean',
  result: FileOpResult,
  inputFile: string,
): { readonly level: 'info' | 'error'; readonly text: string } {
  const gerund = operation === 'pack' ? 'packing' : 'cleaning';
  switch (result.status) {
    case 'success':
      if (operation === 'clean')
        return { level: 'info', text: `Cleanup complete for ${inputFile}` };
      return {
        level: 'info',
        text: result.outputFolder
          ? `Files packed into ${result.outputFolder}`
          : 'Files packed.',
      };
    case 'noFiles':
      return {
        level: 'info',
        text: `No files found to ${operation} for ${inputFile}`,
      };
    case 'missingParams':
      return { level: 'error', text: `Select an input file before ${gerund}.` };
    case 'error':
      return {
        level: 'error',
        text: `Error during ${gerund}: ${result.error}`,
      };
  }
}
