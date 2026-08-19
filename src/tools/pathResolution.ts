// Node imports
import * as path from 'node:path';

// Local imports
import {
  getRunContextWorkingDirectory,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { normalizeFilePath } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import {
  findExternalRoot,
  type MatchedExternalRoot,
} from '@utils/files/externalRoots';
import { locatePathInRoot } from '@utils/files/workspaceRoot';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { getPathSegments, toPosixPath } from '@utils/core/pathCore';

export interface WorkspacePathResolution {
  relative: string;
  absolute: string;
  /**
   * The path to pass to filesystem operations.
   * Absolute when operating outside the workspace (e.g. a worktree),
   * workspace-relative otherwise (for WorkspaceFS compatibility).
   */
  fsPath: string;
  /**
   * When the resolved path falls inside a registered external root, this
   * describes that root (label, writable flag). Undefined for workspace paths
   * and for any external path outside the allowlist.
   */
  external?: { root: string; writable: boolean; label: string };
}

/** Trim and validate a working_directory value. Must be absolute if provided. */
export function parseWorkingDirectory(
  raw: string | null | undefined,
): string | undefined {
  const trimmed = raw?.trim() || undefined;
  if (trimmed && !path.isAbsolute(trimmed)) {
    throw new ToolError(
      `working_directory must be an absolute path, got: ${trimmed}`,
    );
  }
  return trimmed;
}

/**
 * Validated working-directory override for the current tool call.
 *
 * Reads `workingDirectory` from the active RunContext and runs it through
 * `parseWorkingDirectory`. Returns undefined when no run context is active
 * or when no override was set on the launch — callers then fall back to the
 * workspace root via `WorkspaceFS.locatePath`.
 *
 * Centralizes the active-context working-directory lookup and validation
 * pattern that every workspace-touching tool needs.
 */
export function currentToolRoot(): string | undefined {
  return parseWorkingDirectory(
    getRunContextWorkingDirectory(tryUseRunContext()),
  );
}

/** Throw when a raw tool path contains a parent-directory segment. */
export function assertNoParentTraversal(targetPath: string): void {
  if (getPathSegments(targetPath).includes('..')) {
    throw new ToolError(`path must not contain '..': ${targetPath}`);
  }
}

/**
 * Resolve a potentially absolute or relative path against a root directory.
 *
 * When `root` is provided, paths are resolved against that directory instead
 * of the workspace root. This supports operating in git worktrees or other
 * directories outside the main workspace.
 *
 * Thin policy wrapper around WorkspaceFS.locatePath() / locatePathInRoot()
 * that throws ToolError when the path escapes the root. Tools use this;
 * non-tool code should call WorkspaceFS.locatePath() directly.
 */
export function resolveWorkspaceRelativePath(
  targetPath?: string,
  root?: string,
): WorkspacePathResolution {
  const trimmed = targetPath?.trim();
  const input = !trimmed || trimmed === '.' ? '' : trimmed;

  /**
   * Resolve an absolute path that sits outside the containing root: honour a
   * registered external root when one matches, pass the path through when
   * containment is switched off, and otherwise reject with `outsideMessage`.
   *
   * `relative` is set to the full absolute path so the display (rendered via
   * `toPosixPath(relative)`) unambiguously signals an external operation —
   * agents and users should never confuse an external write with a workspace
   * write, even when file basenames collide.
   */
  const resolveOutsideRoot = (
    absolutePath: string,
    match: MatchedExternalRoot | null | undefined,
    outsideMessage: string,
  ): WorkspacePathResolution => {
    // This setting deliberately uses the same workspaceState slot in every
    // host. Do not add a CLI-specific store without also making host identity
    // explicit at this enforcement boundary.
    if (
      !match &&
      readPlatformSetting<boolean>(
        WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
      )
    ) {
      throw new ToolError(outsideMessage);
    }
    return {
      relative: normalizeFilePath(absolutePath),
      absolute: absolutePath,
      fsPath: absolutePath,
      ...(match ? { external: externalInfo(match) } : {}),
    };
  };

  if (root) {
    // Absolute paths need special handling — locatePathInRoot only works with relative paths.
    if (input && path.isAbsolute(input)) {
      // `relativeToRoot` is the shared symlink-aware absolute-path containment
      // helper: it tries a lexical pass, then compares realpaths, so a root and
      // path that name the same directory through different symlink spellings
      // resolve rather than being rejected.
      const relative = relativeToRoot(root, input);
      if (relative === undefined) {
        return resolveOutsideRoot(
          input,
          findExternalRoot(input),
          'Path must stay within the working directory.',
        );
      }
      return annotateExternalPermission({
        relative: relative || '.',
        absolute: input,
        fsPath: input,
      });
    }
    const resolved = locatePathInRoot(root, input);
    if (resolved.kind === 'external') {
      // `annotateExternal` in `locatePathInRoot` already consulted the
      // registry, so reuse that match instead of paying for a second lookup.
      return resolveOutsideRoot(
        resolved.absolutePath,
        resolved.allowed,
        'Path must stay within the working directory.',
      );
    }
    const relative = resolved.relativePath || '.';
    return annotateExternalPermission({
      relative,
      absolute: resolved.absolutePath,
      fsPath: resolved.absolutePath,
    });
  }

  if (!WorkspaceFS.getPath()) {
    // No workspace — fall back to the allowlist so agent-dir calls still work.
    if (input && path.isAbsolute(input)) {
      return resolveOutsideRoot(
        input,
        findExternalRoot(input),
        'Workspace path is not available.',
      );
    }
    throw new ToolError('Workspace path is not available.');
  }

  const resolved = WorkspaceFS.locatePath(input);

  if (resolved.kind === 'external') {
    return resolveOutsideRoot(
      resolved.absolutePath,
      resolved.allowed,
      'Path must stay within the workspace.',
    );
  }

  const relative = resolved.relativePath || '.';
  return { relative, absolute: resolved.absolutePath, fsPath: relative };
}

/** Permission metadata carried for a path inside a registered external root. */
function externalInfo(
  match: MatchedExternalRoot,
): NonNullable<WorkspacePathResolution['external']> {
  return {
    root: match.absolutePath,
    writable: match.writable,
    label: match.label,
  };
}

/**
 * Attach external-root permission metadata when a resolution (from the
 * working_directory branch) happens to land inside a registered root.
 *
 * Without this, a subagent launched with `working_directory` set to a
 * read-only external root (e.g. the built-in agents dir) could bypass
 * `assertWritable` by addressing files with paths relative to `root` —
 * the in-root branches return without touching the allowlist otherwise.
 *
 * Preserves `relative`/`absolute`/`fsPath` as the caller already built
 * them so display and I/O remain unchanged; only `external` is added.
 */
function annotateExternalPermission(
  resolution: WorkspacePathResolution,
): WorkspacePathResolution {
  if (resolution.external) return resolution;
  const match = findExternalRoot(resolution.absolute);
  if (!match) return resolution;
  return { ...resolution, external: externalInfo(match) };
}

/**
 * Throw a ToolError when the resolved path points into a read-only external
 * root. Workspace paths and writable externals pass through. Call this from
 * write/edit tools immediately before requesting approval.
 */
export function assertWritable(
  resolved: WorkspacePathResolution,
  displayPath: string,
): void {
  if (resolved.external && !resolved.external.writable) {
    throw new ToolError(
      `Cannot write ${displayPath}: ${resolved.external.label} is read-only.`,
    );
  }
}

/**
 * Join a workspace-relative base path with a child segment and ensure the
 * result stays within the root directory.
 */
export function joinWorkspaceRelativePath(
  baseRelative: string,
  child: string,
  root?: string,
): WorkspacePathResolution {
  // Use posix.join since baseRelative and child are POSIX-normalized.
  // path.join would reintroduce backslashes on Windows.
  return resolveWorkspaceRelativePath(
    path.posix.join(baseRelative || '.', child),
    root,
  );
}

/**
 * Common pattern for resolving and formatting paths.
 * Returns `path` (resolution with relative/absolute) and `display` (formatted string).
 */
export function resolveAndFormat(
  targetPath?: string,
  root?: string,
): {
  path: WorkspacePathResolution;
  display: string;
} {
  const path = resolveWorkspaceRelativePath(targetPath, root);
  const display = toPosixPath(path.relative);
  return { path, display };
}
