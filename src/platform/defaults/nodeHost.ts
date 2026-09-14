/**
 * Node host composition helpers.
 *
 * All three composition roots (the `texra` CLI runtime, the Electron desktop
 * main process, and the VS Code extension host) wire the same platform
 * skeleton from the same ingredients. This module owns them so the hosts
 * cannot drift; each host still performs the actual `initPlatform(...)` call
 * in its own composition root.
 *
 * This file is a composition helper, not a core platform abstraction: it
 * deliberately reaches "up" into `@agent` and `@skills` for the registration
 * helpers, mirroring what each host's composition root would otherwise inline.
 * Nothing in `@agent` / `@skills` imports it back, so there is no cycle. The
 * direct Lean LSP adapter is not here: each Node root hands its layer to
 * `installProcessRuntime`, so the adapter stays out of hosts that only need
 * the composition helpers.
 */

// Local imports
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import {
  defaultSkillSources,
  type SkillSourceOptions,
} from '@skills/skillSources';

// Local file imports
import { JsonConfigProvider } from './jsonConfigProvider';
import { nodeFilesystem } from './nodeFilesystem';
import { canonicalizeWorkspacePath } from './nodeWorkspace';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '../languageModel';
import type { WorkspaceRoots } from '../workspaceRoots';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  ConfigProvider,
  LifecycleHost,
  StateStore,
  ToolMissingHandler,
} from '../interfaces';
import type { LanguageModelPort } from '../languageModel';
import type { Platform } from '../platform';

/**
 * Host-specific services a Node host supplies to {@link createNodePlatform}. The
 * shared Node default (the filesystem) is filled in by the helper. The
 * per-workspace services are not here: hosts build them with
 * {@link createNodeWorkspaceRoots}.
 */
export interface NodePlatformServices {
  readonly lifecycle: LifecycleHost;
  readonly agentResume: AgentResumePort;
  readonly agentDirectories: AgentDirectoriesPort;
  /** Editor-host subscription models; defaults to the unavailable port. */
  readonly languageModel?: LanguageModelPort;
  /** Optional process-host capability; absent means no-op (see `Platform`). */
  readonly toolMissingHandler?: ToolMissingHandler;
}

/** The per-workspace services a Node host opens for one workspace folder. */
export interface NodeWorkspaceRootsInit {
  readonly workspacePath: string | undefined;
  /** The storage root opened for this workspace (`WorkspaceStorageProvider.getStoragePath()`). */
  readonly storage: string;
  /** The cross-workspace global storage root (`getGlobalStoragePath()`). */
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
 * canonicalization and the config-provider choice cannot drift.
 */
export function createNodeWorkspaceRoots(
  init: NodeWorkspaceRootsInit,
): WorkspaceRoots {
  return {
    workspace:
      init.workspacePath == null
        ? undefined
        : canonicalizeWorkspacePath(init.workspacePath),
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
 * Assemble the platform services for a Node-family host (CLI, desktop,
 * extension) or an SDK embedder.
 *
 * Centralizes the default building blocks every host would otherwise restate
 * in its own `initPlatform` literal (`nodeFilesystem`) while preserving the
 * rule that only composition roots call `initPlatform(...)`.
 */
export function createNodePlatform(services: NodePlatformServices): Platform {
  return {
    fs: nodeFilesystem,
    lifecycle: services.lifecycle,
    agentResume: services.agentResume,
    agentDirectories: services.agentDirectories,
    languageModel: services.languageModel ?? UNAVAILABLE_LANGUAGE_MODEL_PORT,
    // Missing-tool reporting remains an optional process-host capability;
    // omitting it is the no-op, which is what both Node hosts want.
    toolMissingHandler: services.toolMissingHandler,
  };
}

/**
 * Register runtime skill sources for a host.
 *
 * All three hosts use the same precedence: explicit custom roots, project
 * skills, user skills, and bundled skills. The CLI supplies custom and interop
 * options from command-line flags; desktop and the extension use the defaults
 * so they always get project, user, and bundled runtime skills.
 */
export function initializeNodeRuntimeSkills(
  options: NodeRuntimeSkillOptions,
): void {
  // The workspace folder is not fixed here: project and interop sources are
  // resolved from the calling session's workspace at discovery time.
  setRuntimeSkillSources((cwd) =>
    defaultSkillSources(
      { cwd, resourcesPath: options.resourcesPath },
      options.skillSourceOptions,
    ),
  );
}
