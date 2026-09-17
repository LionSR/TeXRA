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
  sessionFsLayer,
  type GlobalStorageFs,
  type StorageFs,
  type WorkspaceFs,
} from '@platform/rootedFs';

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
  return Layer.provideMerge(sessionFsLayer(roots), nodePlatformLayer);
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
