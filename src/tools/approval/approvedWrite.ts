/**
 * Writing an approved edit: the reconciliation of the approved content with
 * the file as it is now, after a wait for approval that can take minutes
 * while other runs write the same workspace.
 */
import * as nodePath from 'node:path';

import { Effect, FileSystem } from 'effect';

import { ToolCall } from '@agent/runtime/ToolCall';
import { WorkspaceFs } from '@platform/rootedFs';
import { ToolError } from '@shared/schemas';
import { recordToolFileRead } from '@tools/fileInteractions';
import { onFileLane } from '@utils/files/fileLanes';
import { entryExists } from '@utils/files/fsEntryExists';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { applyPatchToText } from '@utils/text/diff';

interface WriteApprovedContentResult {
  appliedContent: string;
  baseContent: string;
}

/**
 * The approved edit no longer applies: the file changed on disk while the
 * edit waited for approval (another run, a subagent, the user's editor), and
 * the three-way merge of the approved change onto that version failed.
 * Nothing was written.
 */
class ApprovedEditConflictError extends ToolError {
  constructor(path: string) {
    super(
      `${path} changed on disk while this edit waited for approval, and the approved change no longer applies cleanly to the new content. Nothing was written. Re-read the file and redo the edit.`,
      { summary: `Edit conflict: ${path}` },
    );
  }
}

/**
 * Reconcile approved content with the current workspace file and mark the path
 * as read after the operation succeeds, so every approved-write caller keeps
 * the later-edit guard in sync.
 *
 * The path is written through its own view of the filesystem: a
 * workspace-relative path through the session's confined `WorkspaceFs` view,
 * an already-absolute one (an external root, a worktree) through the process
 * `FileSystem`. The read, the merge and the write hold the file's lane
 * (`onFileLane`), and a merge that fails is an
 * {@link ApprovedEditConflictError} rather than a write of the approved
 * content over the concurrent change.
 */
export const writeApprovedContent = Effect.fn('writeApprovedContent')(
  function* (
    path: string,
    originalContent: string,
    finalContent: string,
  ): Effect.fn.Return<
    WriteApprovedContentResult,
    Error,
    ToolCall | FileSystem.FileSystem | WorkspaceFs
  > {
    yield* ToolCall;
    const workspace = nodePath.isAbsolute(path)
      ? undefined
      : yield* WorkspaceFs;
    const fs = workspace ?? (yield* FileSystem.FileSystem);
    const file = workspace ? yield* workspace.resolve(path) : path;
    const written = yield* Effect.gen(function* () {
      const exists = yield* entryExists(fs, path);
      // All content is already LF-normalized at the FS read boundary,
      // so comparisons work directly without extra normalization.
      const baseContent = exists ? yield* readNormalizedFile(fs, path) : '';
      if (
        exists &&
        (baseContent === finalContent || originalContent === finalContent)
      ) {
        return { appliedContent: baseContent, baseContent };
      }
      let appliedContent = finalContent;
      if (exists && baseContent !== originalContent) {
        const { content, results } = applyPatchToText(
          originalContent,
          finalContent,
          baseContent,
        );
        if (!results.every(Boolean)) {
          return yield* Effect.fail(new ApprovedEditConflictError(path));
        }
        appliedContent = content;
      }
      yield* fs.writeFile(path, Buffer.from(appliedContent, 'utf-8'));
      return { appliedContent, baseContent };
    }).pipe(onFileLane(file));
    yield* recordToolFileRead(path);
    return written;
  },
);

/** {@link writeApprovedContent} for a caller that reports each file's
 *  outcome: a conflict is the value, every other failure stays one. */
export function approvedWriteConflict(
  path: string,
  originalContent: string,
  finalContent: string,
) {
  return writeApprovedContent(path, originalContent, finalContent).pipe(
    Effect.as(undefined),
    Effect.catchIf(
      (error): error is ApprovedEditConflictError =>
        error instanceof ApprovedEditConflictError,
      Effect.succeed,
    ),
  );
}
