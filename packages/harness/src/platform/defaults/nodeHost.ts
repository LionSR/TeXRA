/**
 * Node host composition helper: every Node host (a CLI runtime, a desktop
 * main process, an editor extension host) opens a workspace's roots here, so
 * the storage path, the state stores and the config-provider choice cannot
 * drift. Each host still installs its process runtime in its own composition
 * root and opens its config stores where it reads them. A plugin's language
 * server adapter is not here: each Node root hands its layer to
 * `processLayer`. The SDK's default platform writes its in-memory roots
 * itself (`sdkPlatform.ts`).
 */

// Third-party imports
import { type Context, Effect, type Scope } from 'effect';

// Local file imports
import type { StateStores } from '@platform/processRuntime';
import type { ConfigProvider, StateStore } from '@shared/config/settings';
import type { DatabaseOpenFailed } from '@shared/session/database';
import { JsonConfigProvider } from './jsonConfigProvider';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from './workspaceStorage';
import type { WorkspaceRoots } from '../workspaceRoots';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';

/** What a Node host names to open one workspace folder's roots. */
export interface NodeWorkspaceRootsInit {
  /** The canonical workspace root (`canonicalizeWorkspacePath`), decided by
   *  the host where it reads it; undefined when no folder is open. */
  readonly workspaceRoot: string | undefined;
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /** The workspace, local and global config stores to build the file-backed
   *  provider from, or the provider a host already built from them (the
   *  CLI's, opened by its startup read). */
  readonly config: JsonConfigProviderOptions | ConfigProvider;
  /** The process's `StateStores`, which open the project's and the
   *  repository's stores under the workspace's storage path. */
  readonly stateStores: Context.Service.Shape<typeof StateStores>;
  /** The process's application state (`AppState`), shared by every root. */
  readonly globalState: StateStore;
  /** The project's state store when another process holds it (a background
   *  service the host is a client of); absent, the project's own store opens
   *  in the caller's scope. */
  readonly workspaceState?: StateStore;
}

/**
 * Open the `WorkspaceRoots` for one workspace folder: its pinned storage
 * path under the storage root, the file-backed config provider, the
 * project's state store (held for the caller's scope), the repository's
 * settings and the process's application state. Every host (and the
 * desktop, once per open project) opens its roots here.
 */
export const openNodeWorkspaceRoots: (
  init: NodeWorkspaceRootsInit,
) => Effect.Effect<WorkspaceRoots, DatabaseOpenFailed, Scope.Scope> = Effect.fn(
  'openNodeWorkspaceRoots',
)(function* (init: NodeWorkspaceRootsInit) {
  const { workspaceRoot, storageRoot, stateStores } = init;
  const storage = resolveWorkspaceStoragePath(storageRoot, workspaceRoot);
  return {
    workspace: workspaceRoot,
    storageRoot,
    storage,
    globalStorage: resolveGlobalStoragePath(storageRoot),
    config:
      'workspace' in init.config
        ? new JsonConfigProvider(init.config)
        : init.config,
    workspaceState:
      init.workspaceState ??
      (yield* stateStores.project(storage, workspaceRoot)),
    repoState: yield* stateStores.repo(storage, workspaceRoot),
    globalState: init.globalState,
  };
});
