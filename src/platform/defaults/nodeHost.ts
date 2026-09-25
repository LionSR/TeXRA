/**
 * Node host composition helpers.
 *
 * All three composition roots (the `texra` CLI runtime, the Electron desktop
 * main process, and the VS Code extension host) open a workspace's roots and
 * register their runtime skill sources the same way. This module owns those
 * two steps so the hosts cannot drift; each host still installs its process
 * runtime in its own composition root.
 *
 * This file is a composition helper, not a core platform abstraction: it
 * deliberately reaches "up" into `@agent` and `@skills` for the registration
 * helpers, mirroring what each host's composition root would otherwise inline.
 * Nothing in `@agent` / `@skills` imports it back, so there is no cycle. The
 * direct Lean LSP adapter is not here: each Node root hands its layer to
 * `installProcessRuntime`, so the adapter stays out of hosts that only need
 * the composition helpers. The platform literal itself is not here either:
 * every field of it is host-specific, so each root writes its own.
 */

// Local imports
import { installSkillContributions } from '@skills/runtimeSkills';
import {
  hostSkillContributions,
  type SkillSourceOptions,
} from '@skills/skillSources';

// Local file imports
import { JsonConfigProvider } from './jsonConfigProvider';
import type { WorkspaceRoots } from '../workspaceRoots';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type { ConfigProvider, StateStore } from '../interfaces';

/** The per-workspace services a Node host opens for one workspace folder. */
export interface NodeWorkspaceRootsInit {
  /** The canonical workspace root (`canonicalizeWorkspacePath`), decided by the host where it reads it. */
  readonly workspacePath: string | undefined;
  /** The storage root opened for this workspace (`resolveWorkspaceStoragePath`). */
  readonly storage: string;
  /** The cross-workspace global storage root (`resolveGlobalStoragePath`). */
  readonly globalStorage: string;
  /**
   * Config source: the workspace + global stores to build the file-backed
   * provider from, or an already-constructed provider for hosts that resolve
   * configuration some other way (the SDK's process-local
   * `MemoryConfigProvider`).
   */
  readonly config: JsonConfigProviderOptions | ConfigProvider;
  readonly workspaceState: StateStore;
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
    workspace: init.workspacePath,
    storage: init.storage,
    globalStorage: init.globalStorage,
    config:
      'workspace' in init.config
        ? new JsonConfigProvider(init.config)
        : init.config,
    workspaceState: init.workspaceState,
    globalState: init.globalState,
  };
}

export interface NodeRuntimeSkillOptions {
  readonly resourcesPath: string;
  readonly skillSourceOptions?: SkillSourceOptions;
}

/**
 * Install the runtime skill contributions for a host.
 *
 * All three hosts use the same precedence: explicit custom roots, project
 * skills, user skills, and bundled skills, where the bundled tier also holds
 * the skills each tool plugin in `skillPluginIds` ships. The CLI supplies
 * custom and interop options from command-line flags; desktop and the
 * extension use the defaults so they always get project, user, and bundled
 * runtime skills. The plugin ids are required so a caller that forgets them
 * fails to compile rather than quietly losing plugin skills.
 */
export function initializeNodeRuntimeSkills(
  options: NodeRuntimeSkillOptions,
  skillPluginIds: readonly string[],
): void {
  // The workspace folder is not fixed here: project and interop sources are
  // resolved from the calling session's workspace at discovery time.
  installSkillContributions({
    resourcesPath: options.resourcesPath,
    options: options.skillSourceOptions ?? {},
    contributions: hostSkillContributions(skillPluginIds),
  });
}
