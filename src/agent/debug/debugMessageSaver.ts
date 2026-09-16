import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import {
  resolveRunStoragePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunId } from '@shared/schemas';
import { readConfig } from '@utils/config/configUtils';
import { runDirUnder } from '@utils/files/runStorageFs';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

interface DebugContext {
  logger: AgentTrace;
  modelName?: string;
  runId?: RunId;
  /** Remote agents skip saving to avoid leaking prompts. */
  isRemote?: boolean;
  /**
   * The run's session roots, passed as data. A save with a run id lands under
   * the storage root, a save without one under the workspace root — the two
   * roots the `StorageFS` / `WorkspaceFS` facades read from the ambient
   * `workspaceRoots()` at call time — and the config provider is the
   * session's own, so the `texra.debug.saveModelIO` guard below cannot throw
   * before platform init.
   */
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage' | 'config'>;
}

interface DebugSaveOptions {
  /** Base name for the file (e.g. 'messages', 'response'). */
  baseName?: string;
  continuationCount?: number;
}

type DebugObjectType = 'messages' | 'response';

interface SaveDebugParams {
  object: unknown;
  objectType: DebugObjectType;
  context: DebugContext;
  fileOptions?: DebugSaveOptions;
}

/**
 * Save debug objects (messages or responses) to a JSON file when
 * `texra.debug.saveModelIO` is enabled. Skips remote agents to avoid
 * leaking prompts.
 *
 * Takes the process filesystem from context: the target is an absolute path
 * built from the run's own roots, exactly as `StorageFS` / `WorkspaceFS`
 * resolved theirs, and the write is the same plain (non-atomic) one both
 * facades made through `platform().fs`. A failure is caught and logged, as
 * the old `try`/`catch` did, and never propagates into the run.
 */
export function maybeSaveDebugObject({
  object,
  objectType,
  context,
  fileOptions = {},
}: SaveDebugParams): Effect.Effect<void, never, FileSystem.FileSystem> {
  // `texra.debug.saveModelIO` is the one setting covering request messages,
  // responses, and the final input prompt.
  if (
    !readConfig<boolean>(context.roots.config, 'texra.debug.saveModelIO') ||
    context.isRemote
  )
    return Effect.void;

  const { logger, modelName, runId, roots } = context;
  const { baseName = objectType, continuationCount } = fileOptions;

  const cont = continuationCount ? `_cont${continuationCount}` : '';
  const modelPart = modelName
    ? `_${sanitizePathSegment(modelName, { invalidCharPattern: /[\\/]/g, replacement: '_' })}`
    : '';
  const debugFileName = `${baseName}${modelPart}${cont}.json`;

  // The old `try`/`catch` covered a throw from any step — a filesystem
  // failure, a non-serializable `object`, the no-workspace-folder throw
  // `workspaceAbsolutePath` makes. A typed failure and a thrown defect are
  // both reported here, and neither is left to kill the run.
  const reportSaveFailure = (error: unknown) =>
    Effect.sync(() => {
      logger.error(`Failed to save ${objectType} object`, { data: error });
    });

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = runId
      ? path.join(roots.storage, resolveRunStoragePath(runId, debugFileName))
      : // No run id: a workspace-relative name, and the same throw the
        // `WorkspaceFS` facade made when no folder is open.
        workspaceAbsolutePath(roots.workspace, debugFileName);

    if (runId) {
      // `ensureRunDir`: the runs directory and the run's own, both created
      // tolerantly (a directory that already exists is the post-condition).
      yield* fs.makeDirectory(path.join(roots.storage, RUNS_STORAGE_DIR), {
        recursive: true,
      });
      yield* fs.makeDirectory(runDirUnder(roots.storage, runId), {
        recursive: true,
      });
    }
    yield* fs.writeFile(filePath, Buffer.from(JSON.stringify(object, null, 2)));

    logger.info(`Saved ${objectType} object to ${filePath}`);
  }).pipe(
    Effect.catch(reportSaveFailure),
    Effect.catchDefect(reportSaveFailure),
  );
}
