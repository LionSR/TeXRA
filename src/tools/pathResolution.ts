// Node imports
import * as path from 'node:path';
import { Effect } from 'effect';

// Local imports
import type { SettingsStores } from '@shared/config/settingsAccess';
import { ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { ensureError } from '@utils/errors/errorMessage';
import { normalizeFilePath } from '@utils/core';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import {
  canonicalizePath,
  findExternalRoot,
  type MatchedExternalRoot,
} from '@utils/files/externalRoots';
import { readSettingFrom } from '@utils/config/platformSettings';
import {
  getPathSegments,
  isPathWithin,
  toPosixPath,
} from '@utils/core/pathCore';

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

interface OutsideRootCandidate {
  readonly kind: 'outside-root';
  readonly absolutePath: string;
  readonly match: MatchedExternalRoot | null | undefined;
  readonly outsideMessage: string;
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
 * The call fields a tool path resolves against: the session's roots (its
 * workspace folder and the setting slots containment policy is read from) and
 * the run's working directory. A tool's `ToolCall` satisfies it structurally.
 * `workingDirectory` is already absolute or absent: the run decides it once
 * where it is launched (`assembleAgentLaunchContext`).
 */
export interface ToolPathCall {
  readonly roots: { readonly workspace: string | undefined } & SettingsStores;
  readonly workingDirectory?: string;
}

/** A resolved tool path plus the POSIX form a tool shows for it. */
export interface ToolPathResolution extends WorkspacePathResolution {
  readonly display: string;
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
 * directory when the run has one and its workspace folder otherwise.
 *
 * A path that escapes that root is admitted only inside a registered external
 * root or with path protection switched off; otherwise it fails with a
 * `ToolError` the tool runner reports to the model. With no folder open and
 * no working directory, only an absolute path can resolve (the agent
 * directories are registered external roots).
 *
 * `fsPath` is workspace-relative for a workspace path, so the confined
 * `WorkspaceFs` view answers it, and absolute for a working-directory or
 * outside path.
 */
export function resolveToolPath(call: ToolPathCall, targetPath?: string) {
  return Effect.gen(function* () {
    const settings = call.roots;
    const root = call.workingDirectory ?? call.roots.workspace;
    const scope = call.workingDirectory ? 'working directory' : 'workspace';
    const resolution = yield* Effect.try({
      try: (): WorkspacePathResolution | OutsideRootCandidate => {
        const trimmed = targetPath?.trim();
        const input = !trimmed || trimmed === '.' ? '' : trimmed;

        if (!root) {
          // No workspace: only the allowlist admits a path, so agent-dir
          // calls still work.
          if (input && path.isAbsolute(input)) {
            return {
              kind: 'outside-root',
              absolutePath: input,
              match: findExternalRoot(input),
              outsideMessage: 'Workspace path is not available.',
            };
          }
          throw new ToolError('Workspace path is not available.');
        }

        const resolved = locateInWorkspace(root, input);
        if (resolved.kind === 'external') {
          // `locateInWorkspace` already consulted the external-root registry,
          // so its match is reused rather than looked up again.
          return {
            kind: 'outside-root',
            absolutePath: resolved.absolutePath,
            match: resolved.allowed,
            outsideMessage: `Path must stay within the ${scope}.`,
          };
        }
        const relative = resolved.relativePath || '.';
        // Lexical containment is not physical containment: a symlink inside
        // the root (`ln -s .. up`) makes `up/x` name a file outside it. The
        // realpath of the path's deepest existing ancestor must stay inside
        // the root's; one that leaves is an outside-root path at its real
        // location, so the allowlist, the protection setting and the
        // approval UI all see where the read or write actually lands.
        const physical = canonicalizePath(resolved.absolutePath);
        if (!isPathWithin(canonicalizePath(root), physical)) {
          return {
            kind: 'outside-root',
            absolutePath: physical,
            match: findExternalRoot(physical),
            outsideMessage: `Path must stay within the ${scope}. ${toPosixPath(relative)} resolves through a symlink to ${normalizeFilePath(physical)}.`,
          };
        }
        return annotateExternalPermission({
          relative,
          absolute: resolved.absolutePath,
          fsPath: call.workingDirectory ? resolved.absolutePath : relative,
        });
      },
      catch: ensureError,
    });

    if (!('kind' in resolution)) {
      return { ...resolution, display: toPosixPath(resolution.relative) };
    }
    // This setting deliberately uses the same workspaceState slot in every
    // host. Do not add a CLI-specific store without also making host identity
    // explicit at this enforcement boundary. Registered external roots need no
    // containment override, so keep their resolution independent of the store.
    if (
      !resolution.match &&
      (yield* readSettingFrom<boolean>(
        settings,
        WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
      ))
    ) {
      return yield* Effect.fail(new ToolError(resolution.outsideMessage));
    }
    // `relative` is the full absolute path so an external operation never
    // reads as a workspace one, even when basenames collide.
    const relative = normalizeFilePath(resolution.absolutePath);
    return {
      relative,
      absolute: resolution.absolutePath,
      fsPath: resolution.absolutePath,
      // Already forward-slashed; `toPosixPath` would drop the leading `/`.
      display: relative,
      ...(resolution.match ? { external: externalInfo(resolution.match) } : {}),
    };
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
 * root. Workspace paths and writable externals pass through. The run loop
 * calls this for the paths a tool declares in `ToolGuard.writes`, before the
 * body runs; a tool does not call it itself.
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
