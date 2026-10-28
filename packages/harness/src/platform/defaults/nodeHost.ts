/**
 * Node host composition helper: every Node composition root (a CLI runtime,
 * a desktop main process, an editor extension host, the SDK's default
 * platform) opens a workspace's roots here, so the config-provider choice
 * cannot drift. Each host still installs its process runtime in its own
 * composition root. A plugin's language server adapter is not here: each
 * Node root hands its layer to `processLayer`. The platform literal itself
 * is not here either: every field of it is host-specific, so each root
 * writes its own.
 */

// Local imports
import type { SettingHost } from '@shared/state/stateSettings';

// Local file imports
import { JsonConfigProvider } from './jsonConfigProvider';
import { resolveGlobalStoragePath } from './workspaceStorage';
import type { WorkspaceRoots } from '../workspaceRoots';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type { ConfigProvider, StateStore } from '../interfaces';

/** The per-workspace services a Node host opens for one workspace folder. */
export interface NodeWorkspaceRootsInit {
  /** The product host opening these roots (`WorkspaceRoots.host`). */
  readonly host: SettingHost;
  /** The canonical workspace root (`canonicalizeWorkspacePath`), decided by the host where it reads it. */
  readonly workspacePath: string | undefined;
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /** The storage root opened for this workspace (`resolveWorkspaceStoragePath`). */
  readonly storage: string;
  /**
   * Config source: the workspace + global stores to build the file-backed
   * provider from, or an already-constructed provider for hosts that resolve
   * configuration some other way (the SDK's process-local
   * `MemoryConfigProvider`).
   */
  readonly config: JsonConfigProviderOptions | ConfigProvider;
  readonly workspaceState: StateStore;
  /** The repository settings (`WorkspaceRoots.repoState`). */
  readonly repoState: StateStore;
  /** The process's application state store (`WorkspaceRoots.globalState`). */
  readonly globalState: StateStore;
}

/**
 * Build the `WorkspaceRoots` for one workspace folder: the canonical physical
 * root, the pinned storage path, and the config/state stores opened for it.
 * Every host (and the desktop, once per open paper) builds its roots here so
 * the config-provider choice cannot drift.
 */
export function createNodeWorkspaceRoots(
  init: NodeWorkspaceRootsInit,
): WorkspaceRoots {
  return {
    host: init.host,
    workspace: init.workspacePath,
    storageRoot: init.storageRoot,
    storage: init.storage,
    globalStorage: resolveGlobalStoragePath(init.storageRoot),
    config:
      'workspace' in init.config
        ? new JsonConfigProvider(init.config)
        : init.config,
    workspaceState: init.workspaceState,
    repoState: init.repoState,
    globalState: init.globalState,
  };
}
