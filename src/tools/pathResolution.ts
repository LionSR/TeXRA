// Node imports
import * as path from 'node:path';

// Local imports
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { normalizeFilePath } from '@utils/core';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import {
  findExternalRoot,
  type MatchedExternalRoot,
} from '@utils/files/externalRoots';
import { locatePathInRoot } from '@utils/files/workspaceRoot';
import { readSettingFrom } from '@utils/config/platformSettings';
import { getPathSegments, toPosixPath } from '@utils/core/pathCore';

export interface WorkspacePathResolution {
  relative: string;
  absolute: string;
  /**
   * The path to pass to filesystem operations.
   * Absolute when operating outside the workspace (e.g. a worktree),
   * workspace-relative otherwise.
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
 * The scoped path-resolution capability a native tool reads from its call: the
 * working-directory root and the setting slots containment policy is read
 * from. Tools that need more from their call (a host viewer, a read tracker,
 * the host frame a legacy host API runs inside) extend this interface with
 * those fields.
 */
export interface WorkspacePathPorts {
  /** The workspace root of the call's session; `undefined` with no folder open. */
  readonly workspaceRoot: string | undefined;
  /**
   * The active working directory, bound to the calling turn. It stays a thunk
   * because {@link parseWorkingDirectory} rejects a relative directory, so each
   * tool forces it exactly at the use site where reporting that failure is
   * theirs to own — never eagerly at assembly time.
   */
  readonly toolRoot: () => string | undefined;
  /**
   * The setting slots of the call's session, carried as data from the tool's
   * `ToolCall`: path containment answers for that project rather than for
   * whichever roots the calling fiber happens to carry.
   */
  readonly settings: SettingsStores;
}

/**
 * Assemble the {@link WorkspacePathPorts} that every path-taking tool binds
 * identically from its `ToolCall`, so the working-directory convention lives in
 * one place. `call` is structural — a tool's `ToolCall` value satisfies it,
 * and its `roots` carry the three setting slots.
 */
export const workspacePathPorts = (call: {
  readonly roots: { readonly workspace: string | undefined } & SettingsStores;
  readonly workingDirectory?: string;
}): WorkspacePathPorts => ({
  workspaceRoot: call.roots.workspace,
  toolRoot: () => parseWorkingDirectory(call.workingDirectory),
  settings: call.roots,
});

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
 * Thin policy wrapper around locateInWorkspace() / locatePathInRoot() that
 * throws ToolError when the path escapes the root. Tools use this;
 * non-tool code calls locateInWorkspace() directly.
 *
 * `settings` are the calling session's setting slots and `workspaceRoot` its
 * workspace folder, both carried as data from the tool's `ToolCall`;
 * `workspaceRoot` is `undefined` when no folder is open.
 */
export function resolveWorkspaceRelativePath(
  settings: SettingsStores,
  workspaceRoot: string | undefined,
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
      readSettingFrom<boolean>(
        settings,
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

  if (!workspaceRoot) {
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

  const resolved = locateInWorkspace(workspaceRoot, input);

  if (resolved.kind === 'external') {
    return resolveOutsideRoot(
      resolved.absolutePath,
      resolved.allowed,
      'Path must stay within the workspace.',
    );
  }

  const relative = resolved.relativePath || '.';
  return annotateExternalPermission({
    relative,
    absolute: resolved.absolutePath,
    fsPath: relative,
  });
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
 * Attach external-root permission metadata when a resolution that stayed
 * inside its containing root (the `working_directory` branch or the
 * workspace branch) happens to land inside a registered root.
 *
 * Containment inside a root does not imply writability: a registered
 * read-only root may itself sit inside the workspace or the working
 * directory — the packaged agent definitions do exactly that when the
 * extension is run from its own source checkout, where `resourcesPath`
 * is `${workspaceFolder}/packages/extension/resources`. Without this the
 * in-root branches return without touching the allowlist, and
 * `assertWritable` would let `write_file`/`edit_file` overwrite files the
 * host registered `writable: false`.
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
 * Common pattern for resolving and formatting paths.
 * Returns `path` (resolution with relative/absolute) and `display` (formatted string).
 */
export function resolveAndFormat(
  settings: SettingsStores,
  workspaceRoot: string | undefined,
  targetPath?: string,
  root?: string,
): {
  path: WorkspacePathResolution;
  display: string;
} {
  const path = resolveWorkspaceRelativePath(
    settings,
    workspaceRoot,
    targetPath,
    parseWorkingDirectory(root),
  );
  const display = toPosixPath(path.relative);
  return { path, display };
}
