import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { InvocationRef, RunId } from '@shared/schemas';
import { Settings } from '@shared/config/settings';
import { runDirUnder } from '@utils/files/runStorageFs';

/** One model request or response to save under its run's directory. */
interface SaveDebugParams {
  readonly object: unknown;
  readonly objectType: 'messages' | 'response';
  /** The attempt the object belongs to: one file per attempt and type. */
  readonly invocation: InvocationRef;
  readonly logger: AgentTrace;
  readonly modelName: string;
  readonly runId: RunId;
  /**
   * The run's session roots, passed as data: the file lands under the
   * storage root, and the config provider is the session's own, so the
   * `texra.debug.saveModelIO` guard below cannot throw before platform init.
   */
  readonly roots: WorkspaceRoots;
}

/**
 * Save debug objects (messages or responses) to a JSON file when
 * `texra.debug.saveModelIO` is enabled.
 *
 * Takes the process filesystem from context: the target is an absolute path
 * built from the run's own roots, and the write is a plain (non-atomic) one.
 * A failure is caught and logged and never propagates into the run.
 */
export function maybeSaveDebugObject({
  object,
  objectType,
  invocation,
  logger,
  modelName,
  runId,
  roots,
}: SaveDebugParams): Effect.Effect<void, never, FileSystem.FileSystem> {
  const modelPart = modelName.replaceAll(/[\\/]/g, '_');
  const runDir = runDirUnder(roots.storage, runId);
  const filePath = path.join(
    runDir,
    `${objectType}_${modelPart}_${invocation.invocationId}_a${invocation.attempt}.json`,
  );

  // A typed failure (the filesystem) and a thrown defect (a non-serializable
  // `object`) are both reported here, and neither is left to kill the run.
  const reportSaveFailure = (error: unknown) =>
    Effect.sync(() => {
      logger.error(`Failed to save ${objectType} object`, { data: error });
    });

  return Effect.gen(function* () {
    if (!(yield* Settings.get<boolean>(roots, 'texra.debug.saveModelIO')))
      return;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(runDir, { recursive: true });
    yield* fs.writeFile(filePath, Buffer.from(JSON.stringify(object, null, 2)));

    logger.info(`Saved ${objectType} object to ${filePath}`);
  }).pipe(
    Effect.catch(reportSaveFailure),
    Effect.catchDefect(reportSaveFailure),
  );
}
