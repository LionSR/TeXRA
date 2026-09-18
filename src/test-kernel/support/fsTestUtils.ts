/**
 * Shared filesystem assertions and error factories for suites exercising
 * real-filesystem behavior.
 */

// Node imports
import { stat } from 'node:fs/promises';

// Third-party imports
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { type FileSystem, Layer, type Path } from 'effect';

// Local imports
import {
  GlobalStorageFs,
  globalStorageFsLayer,
  sessionFsLayer,
  type StorageFs,
  type WorkspaceFs,
} from '@platform/rootedFs';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

/**
 * The `FileSystem` and `Path` services `installProcessRuntime` provides once
 * per process, for a suite that runs a real-filesystem program on
 * `it.effect`'s own runtime rather than the installed one.
 */
export const nodePlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
);

/**
 * The session's rooted filesystems over real temp roots, together with the
 * Node `FileSystem` and `Path` beneath them — what a suite running a
 * `WorkspaceFs` / `StorageFs` consumer on `it.effect`'s own runtime provides,
 * including one that reads a selection outside the roots through the
 * process `FileSystem`.
 */
export function rootedFsLayer(roots: {
  readonly workspace: string | undefined;
  readonly storage: string;
  readonly globalStorage: string;
}): Layer.Layer<
  WorkspaceFs | StorageFs | GlobalStorageFs | FileSystem.FileSystem | Path.Path
> {
  return Layer.provideMerge(
    Layer.merge(
      sessionFsLayer(roots),
      globalStorageFsLayer(roots.globalStorage),
    ),
    nodePlatformLayer,
  );
}

/**
 * A `GlobalStorageFs` no program under test reaches: a suite whose fake host
 * answers `agentDirectories.custom()` from a directory of its own still names
 * the service in its requirements, and this satisfies that type without
 * standing up a root nothing reads.
 */
export const unusedGlobalStorageFs: Layer.Layer<GlobalStorageFs> =
  Layer.succeed(GlobalStorageFs)({} as RootedFileSystem);

/**
 * The process's cross-workspace storage view over `root` — what
 * `installProcessRuntime` serves as `GlobalStorageFs` — for a suite that runs
 * one of its consumers on `it.effect`'s own runtime.
 */
export function globalStorageFsTestLayer(
  root: string,
): Layer.Layer<GlobalStorageFs> {
  return Layer.provide(globalStorageFsLayer(root), nodePlatformLayer);
}

/**
 * Whether `path` exists on disk. Non-ENOENT stat failures (permissions,
 * I/O) propagate — a path that cannot be inspected is not "absent".
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Builds an `Error` carrying an errno-style `code` (e.g. 'ENOENT'). */
export function errnoError(
  code: string,
  message = code,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
