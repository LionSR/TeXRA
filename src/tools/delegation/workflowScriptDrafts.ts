// Saving a submitted workflow script as a draft: every source submission
// lands as a unique, non-overwriting file under the workspace's
// `.texra/workflow-scripts/`, so a failed run can be edited and retried by path.

import * as nodePath from 'node:path';
import { Effect, FileSystem } from 'effect';

import { WorkspaceFs } from '@platform/rootedFs';
import {
  assertWritable,
  resolveToolPath,
  type ToolPathCall,
} from '@tools/pathResolution';
import { entryExists } from '@utils/files/fsEntryExists';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { ensureError } from '@utils/errors/errorMessage';

const WORKFLOW_SCRIPT_DIRECTORY = '.texra/workflow-scripts';

function workflowScriptDraftStem(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `draft-${slug || 'workflow'}`;
}

/**
 * The view of a resolved tool path's own filesystem: a workspace-relative
 * path (`fsPath` stays relative inside the session's folder) goes through the
 * session's confined `WorkspaceFs` view, and an absolute one — a path the
 * caller chose outside the workspace — through the process `FileSystem`.
 */
export const fileSystemAt = (
  fsPath: string,
): Effect.Effect<
  FileSystem.FileSystem,
  never,
  FileSystem.FileSystem | WorkspaceFs
> =>
  Effect.gen(function* () {
    if (nodePath.isAbsolute(fsPath)) {
      return yield* FileSystem.FileSystem;
    }
    return yield* WorkspaceFs;
  });

export const persistWorkflowScript = Effect.fn('persistWorkflowScript')(
  function* (script: string, submissionId: string, call: ToolPathCall) {
    const directory = yield* resolveToolPath(call, WORKFLOW_SCRIPT_DIRECTORY);
    assertWritable(directory, WORKFLOW_SCRIPT_DIRECTORY);
    const directoryFs = yield* fileSystemAt(directory.fsPath);
    yield* directoryFs
      .makeDirectory(directory.fsPath, { recursive: true })
      .pipe(Effect.mapError(ensureError));
    const stem = workflowScriptDraftStem(submissionId);
    for (let suffix = 0; ; suffix += 1) {
      const filename =
        suffix === 0 ? `${stem}.mjs` : `${stem}-${suffix + 1}.mjs`;
      const resolved = yield* resolveToolPath(
        call,
        `${WORKFLOW_SCRIPT_DIRECTORY}/${filename}`,
      );
      assertWritable(resolved, resolved.relative);
      const fs = yield* fileSystemAt(resolved.fsPath);
      const exists = yield* entryExists(fs, resolved.fsPath);
      if (exists) {
        const existing = yield* readNormalizedFile(fs, resolved.fsPath).pipe(
          Effect.mapError(ensureError),
        );
        if (existing === script) {
          return resolved.relative;
        }
        continue;
      }
      yield* fs
        .writeFile(resolved.fsPath, Buffer.from(script, 'utf-8'))
        .pipe(Effect.mapError(ensureError));
      return resolved.relative;
    }
  },
);
