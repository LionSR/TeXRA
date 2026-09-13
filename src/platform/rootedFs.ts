/**
 * The two rooted filesystems of a session, as Effect services (injection
 * plan §5, steps 9-10): the workspace the session works on, and the storage
 * root it keeps its own state under.
 *
 * Each value is a {@link RootedFileSystem} — the standard library's
 * `FileSystem` confined to one root — and each layer captures that root when
 * it is built. A consumer therefore takes a filesystem from context and can
 * neither read nor influence which workspace it points at, which is what
 * lets the `inScope` wrappers around tool I/O go away: they exist only to
 * put the right value into `workspaceRoots()`'s AsyncLocalStorage before a
 * `WorkspaceFS` call reads it.
 */

// Third-party imports
import { Context, Effect, FileSystem, Layer, Path } from 'effect';

// Local imports
import {
  rootedFileSystem,
  type RootedFileSystem,
} from '@utils/files/rootedFileSystem';

import type { WorkspaceRoots } from './workspaceRoots';

/** The workspace folder the session works on. */
export class WorkspaceFs extends Context.Service<
  WorkspaceFs,
  RootedFileSystem
>()('@texra/platform/WorkspaceFs') {}

/** The session's own storage root (`~/.texra/...` by default). */
export class StorageFs extends Context.Service<StorageFs, RootedFileSystem>()(
  '@texra/platform/StorageFs',
) {}

/** A rooted view built from the `FileSystem` and `Path` the process provides. */
function rootedLayer<I>(
  tag: Context.Key<I, RootedFileSystem>,
  root: string | undefined,
): Layer.Layer<I, never, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(tag)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return rootedFileSystem(root, fs, path);
    }),
  );
}

/**
 * The workspace filesystem of `root`, named here rather than exported: a
 * session hands out both of its filesystems together, through
 * {@link sessionFsLayer}. `undefined` is the session with no folder open:
 * the view still exists, and every operation on it fails with `BadArgument`
 * instead of resolving against some other root.
 */
function workspaceFsLayer(
  root: string | undefined,
): Layer.Layer<WorkspaceFs, never, FileSystem.FileSystem | Path.Path> {
  return rootedLayer(WorkspaceFs, root);
}

/** The storage filesystem of `root`. */
function storageFsLayer(
  root: string,
): Layer.Layer<StorageFs, never, FileSystem.FileSystem | Path.Path> {
  return rootedLayer(StorageFs, root);
}

/**
 * Both rooted filesystems of one session, for the host boundaries that hold
 * a session's roots and run a program over its files. `FileSystem` and
 * `Path` stay requirements: they are process services the runtime already
 * provides, and building a second filesystem here would be a second base.
 */
export function sessionFsLayer(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): Layer.Layer<
  WorkspaceFs | StorageFs,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Layer.merge(
    workspaceFsLayer(roots.workspace),
    storageFsLayer(roots.storage),
  );
}

/**
 * Run `program` over the rooted filesystems of `roots` — the form a host
 * boundary uses, so a file that only settles a housekeeping program does not
 * have to name `Effect` as a value to provide a layer.
 */
export function withSessionFs<A, E, R>(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  program: Effect.Effect<A, E, R | WorkspaceFs | StorageFs>,
): Effect.Effect<
  A,
  E,
  Exclude<R, WorkspaceFs | StorageFs> | FileSystem.FileSystem | Path.Path
> {
  return Effect.provide(program, sessionFsLayer(roots));
}
