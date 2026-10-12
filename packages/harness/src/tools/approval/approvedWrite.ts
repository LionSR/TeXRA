/**
 * Writing an approved edit: the reconciliation of the approved content with
 * the file as it is now, after a wait for approval that can take minutes
 * while other runs write the same workspace.
 */
import * as nodePath from 'node:path';

import { Effect, FileSystem } from 'effect';

import { ToolContext } from '@agent/core/tools/ToolTypes';
import { recordToolFileRead } from '@agent/runtime/RunCall';
import { WorkspaceFs } from '@platform/rootedFs';
import { ToolError } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { entryExists } from '@utils/files/fsEntryExists';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { mergeEditOnto } from '@utils/text/unifiedDiff';

interface WriteApprovedContentResult {
  appliedContent: string;
  baseContent: string;
}

/**
 * The approved edit no longer applies: the file changed on disk while the
 * edit waited for approval (another run, a subagent, the user's editor), and
 * the approved change overlaps a change made to that version, or the
 * file was deleted or created meanwhile. Nothing was written.
 */
class ApprovedEditConflictError extends ToolError {
  constructor(path: string) {
    super(
      `${path} changed on disk, was deleted or was created while this edit waited for approval, so the approved change no longer applies. Nothing was written. Re-read the file and redo the edit.`,
      { summary: `Edit conflict: ${path}` },
    );
  }
}

/**
 * One process-wide lane per file for the read, merge and write of an
 * approved edit: the approval wait can take minutes while parallel runs edit
 * the same files. Keyed by the file's real path (a new file's nearest
 * existing ancestor's, joined with the rest), so a symlink and its target
 * meet on one lane; `withPerKeyLane` deletes a lane once idle.
 */
const approvedWriteLanes = new Map<string, PerKeyLane>();

function realPathOf(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<string> {
  const parent = nodePath.dirname(file);
  return fs.realPath(file).pipe(
    // Only the lane key: whatever the I/O fails on, the write reports.
    Effect.catch(() =>
      parent === file
        ? Effect.succeed(file)
        : realPathOf(fs, parent).pipe(
            Effect.map((dir) => nodePath.join(dir, nodePath.basename(file))),
          ),
    ),
  );
}

/**
 * Reconcile approved content with the current workspace file and mark the path
 * as read after the operation succeeds, so every approved-write caller keeps
 * the later-edit guard in sync.
 *
 * The path is written through its own view of the filesystem: a
 * workspace-relative path through the session's confined `WorkspaceFs` view,
 * an already-absolute one (an external root, a worktree) through the process
 * `FileSystem`. The read, the merge and the write hold the file's lane,
 * and a merge that fails is an
 * {@link ApprovedEditConflictError} rather than a write of the approved
 * content over the concurrent change.
 */
export const writeApprovedContent = Effect.fn('writeApprovedContent')(
  function* (
    path: string,
    /** The file as the edit was proposed against; `null` when it did not
     *  exist, which is not the same as an empty file. */
    original: string | null,
    finalContent: string,
  ): Effect.fn.Return<
    WriteApprovedContentResult,
    Error,
    ToolContext | FileSystem.FileSystem | WorkspaceFs
  > {
    yield* ToolContext;
    const workspace = nodePath.isAbsolute(path)
      ? undefined
      : yield* WorkspaceFs;
    const fs = workspace ?? (yield* FileSystem.FileSystem);
    const file = workspace ? yield* workspace.resolve(path) : path;
    const lane = yield* realPathOf(
      yield* FileSystem.FileSystem,
      nodePath.resolve(file),
    );
    const written = yield* Effect.gen(function* () {
      const exists = yield* entryExists(fs, path);
      // All content is already LF-normalized at the FS read boundary,
      // so comparisons work directly without extra normalization.
      const baseContent = exists ? yield* readNormalizedFile(fs, path) : '';
      const unchanged = { appliedContent: baseContent, baseContent };
      if (exists && baseContent === finalContent) return unchanged;
      // The file must be there exactly when it was there at proposal: one
      // deleted meanwhile is not recreated, one created meanwhile is not
      // merged into.
      if (exists !== (original !== null)) {
        return yield* Effect.fail(new ApprovedEditConflictError(path));
      }
      if (original === finalContent) return unchanged;
      let appliedContent = finalContent;
      if (original !== null && baseContent !== original) {
        const merged = mergeEditOnto(original, finalContent, baseContent);
        if (merged === undefined) {
          return yield* Effect.fail(new ApprovedEditConflictError(path));
        }
        appliedContent = merged;
      }
      // A new file lands in its directories as an editor's save does: the
      // parents are created inside the same view the file is written through.
      if (!exists)
        yield* fs.makeDirectory(nodePath.dirname(path), { recursive: true });
      yield* fs.writeFile(path, Buffer.from(appliedContent, 'utf-8'));
      return { appliedContent, baseContent };
    }).pipe(withPerKeyLane(approvedWriteLanes, lane));
    yield* recordToolFileRead(path);
    return written;
  },
);

/** {@link writeApprovedContent} for a caller that reports each file's
 *  outcome: a conflict is the value, every other failure stays one. */
export function approvedWriteConflict(
  path: string,
  original: string | null,
  finalContent: string,
) {
  return writeApprovedContent(path, original, finalContent).pipe(
    Effect.as(undefined),
    Effect.catchIf(
      (error): error is ApprovedEditConflictError =>
        error instanceof ApprovedEditConflictError,
      Effect.succeed,
    ),
  );
}
