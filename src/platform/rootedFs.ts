/**
 * The rooted filesystems of a session, as Effect services (injection
 * plan §5, steps 9-10): the workspace the session works on, the storage
 * root it keeps its own state under, and the cross-workspace global root.
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

/**
 * The cross-workspace global storage root, shared by every session of the
 * process. The third of the roots `WorkspaceRoots` carries, and the one
 * `GlobalStorageFS` resolves its paths against.
 */
export class GlobalStorageFs extends Context.Service<
  GlobalStorageFs,
  RootedFileSystem
>()('@texra/platform/GlobalStorageFs') {}

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
 * Every rooted filesystem of one session, for the host boundaries that hold
 * a session's roots and run a program over its files. `roots.workspace` is
 * `undefined` for the session with no folder open: the view still exists, and
 * every operation on it fails with `BadArgument` instead of resolving against
 * some other root. `FileSystem` and `Path` stay requirements: they are
 * process services the runtime already provides, and building a second
 * filesystem here would be a second base.
 */
export function sessionFsLayer(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage' | 'globalStorage'>,
): Layer.Layer<
  WorkspaceFs | StorageFs | GlobalStorageFs,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Layer.mergeAll(
    rootedLayer(WorkspaceFs, roots.workspace),
    rootedLayer(StorageFs, roots.storage),
    rootedLayer(GlobalStorageFs, roots.globalStorage),
  );
}

/**
 * Run `program` over the rooted filesystems of `roots` — the form a host
 * boundary uses, so a file that only settles a housekeeping program does not
 * have to name `Effect` as a value to provide a layer.
 */
export function withSessionFs<A, E, R>(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage' | 'globalStorage'>,
  program: Effect.Effect<A, E, R | WorkspaceFs | StorageFs | GlobalStorageFs>,
): Effect.Effect<
  A,
  E,
  | Exclude<R, WorkspaceFs | StorageFs | GlobalStorageFs>
  | FileSystem.FileSystem
  | Path.Path
> {
  return Effect.provide(program, sessionFsLayer(roots));
}
