import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunId } from '@shared/schemas';
import { readSettingFrom } from '@utils/config/platformSettings';
import { resolveRunStoragePath, runDirUnder } from '@utils/files/runStorageFs';
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
   * the storage root, a save without one under the workspace root, and the
   * config provider is the session's own, so the `texra.debug.saveModelIO`
   * guard below cannot throw before platform init.
   */
  roots: WorkspaceRoots;
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
 * built from the run's own roots, and the write is a plain (non-atomic) one.
 * A failure is caught and logged, as the old `try`/`catch` did, and never
 * propagates into the run.
 */
export function maybeSaveDebugObject({
  object,
  objectType,
  context,
  fileOptions = {},
}: SaveDebugParams): Effect.Effect<void, never, FileSystem.FileSystem> {
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
    if (
      context.isRemote ||
      !(yield* readSettingFrom<boolean>(
        context.roots,
        'texra.debug.saveModelIO',
      ))
    )
      return;
    const fs = yield* FileSystem.FileSystem;
    const filePath = runId
      ? path.join(roots.storage, resolveRunStoragePath(runId, debugFileName))
      : // No run id: a workspace-relative name, and the same throw
        // `workspaceAbsolutePath` makes when no folder is open.
        workspaceAbsolutePath(roots.workspace, debugFileName);

    if (runId) {
      // `ensureRunDir`: the runs directory and the run's own, both created
      // tolerantly (a directory that already exists is the post-condition).
      yield* fs.makeDirectory(
        path.join(roots.storage, WORKSPACE_STORAGE_LAYOUT.runs),
        {
          recursive: true,
        },
      );
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
