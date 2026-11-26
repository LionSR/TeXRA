// Node imports
import * as path from 'node:path';
import { Effect, Result } from 'effect';

// Local imports
import { asToolError, ToolError } from '@shared/schemas';
import { normalizeFilePath } from '@utils/core/pathBasics';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import { canonicalizePath } from '@utils/files/externalRoots';
import {
  getPathSegments,
  isPathWithin,
  toPosixPath,
} from '@utils/core/pathCore';

/** A tool path resolved against the call's root: its root-relative and
 *  absolute spellings, the path filesystem calls take, and the POSIX form
 *  a tool shows for it. */
export interface ToolPathResolution {
  readonly relative: string;
  readonly absolute: string;
  /**
   * The path to pass to filesystem operations.
   * Absolute when operating outside the workspace (e.g. a worktree),
   * workspace-relative otherwise.
   */
  readonly fsPath: string;
  readonly display: string;
}

/** Trim and validate a working_directory value. Must be absolute if provided. */
export function parseWorkingDirectory(
  raw: string | null | undefined,
): Result.Result<string | undefined, ToolError> {
  const trimmed = raw?.trim() || undefined;
  if (trimmed && !path.isAbsolute(trimmed)) {
    return Result.fail(
      new ToolError(
        `working_directory must be an absolute path, got: ${trimmed}`,
      ),
    );
  }
  return Result.succeed(trimmed);
}

/**
 * The call fields a tool path resolves against: the session's workspace
 * folder and the run's working directory. A tool's `ToolContext.env`
 * satisfies it structurally. `workingDirectory` is already absolute or
 * absent: the run decides it once where it is launched
 * (`buildAgentLaunchContext`).
 */
export interface ToolPathCall {
  readonly roots: { readonly workspace: string | undefined };
  readonly workingDirectory?: string;
}

/** Fail when a raw tool path contains a parent-directory segment. */
export const assertNoParentTraversal = (
  targetPath: string,
): Effect.Effect<void, ToolError> =>
  getPathSegments(targetPath).includes('..')
    ? Effect.fail(new ToolError(`path must not contain '..': ${targetPath}`))
    : Effect.void;

/**
 * Resolve a tool path, relative or absolute, against the call's working
 * directory when the run has one and its workspace folder otherwise. A path
 * outside that root resolves to itself: a call reaches any file the process
 * can. With no folder open and no working directory, only an absolute path
 * can resolve.
 *
 * `fsPath` is workspace-relative for a workspace path, so the confined
 * `WorkspaceFs` view answers it, and absolute for a working-directory or
 * outside path.
 */
export const resolveToolPath = Effect.fn('resolveToolPath')(function* (
  call: ToolPathCall,
  targetPath?: string,
): Effect.fn.Return<ToolPathResolution, ToolError> {
  const root = call.workingDirectory ?? call.roots.workspace;
  return yield* Effect.try({
    try: (): ToolPathResolution => {
      const trimmed = targetPath?.trim();
      const input = !trimmed || trimmed === '.' ? '' : trimmed;
      // `relative` of an outside path is the full absolute path, so it never
      // reads as a workspace one, even when basenames collide. Already
      // forward-slashed; `toPosixPath` would drop the leading `/`.
      const outside = (absolute: string): ToolPathResolution => {
        const relative = normalizeFilePath(absolute);
        return { relative, absolute, fsPath: absolute, display: relative };
      };
      if (!root) {
        if (input && path.isAbsolute(input)) return outside(input);
        throw new ToolError('Workspace path is not available.');
      }
      const resolved = locateInWorkspace(root, input);
      if (resolved.kind === 'external') return outside(resolved.absolutePath);
      // A symlink inside the root (`ln -s .. up`) makes `up/x` name a file
      // outside it, which the confined workspace view would refuse: such a
      // path is an outside one at its real location.
      const physical = canonicalizePath(resolved.absolutePath);
      if (!isPathWithin(canonicalizePath(root), physical))
        return outside(physical);
      const relative = resolved.relativePath || '.';
      return {
        relative,
        absolute: resolved.absolutePath,
        fsPath: call.workingDirectory ? resolved.absolutePath : relative,
        display: toPosixPath(relative),
      };
    },
    catch: asToolError,
  });
});
