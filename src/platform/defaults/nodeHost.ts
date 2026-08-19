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
 * direct Lean LSP registration lives in `nodeAgentRuntime.ts` instead, so that
 * adapter stays out of hosts that only need the composition helpers.
 */

// Local imports
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import {
  defaultSkillSources,
  type SkillSourceOptions,
} from '@skills/skillSources';
import { KeyedMutex } from '@utils/core/keyedMutex';

// Local file imports
import { nodeFileLocks } from './fileLocks';
import { JsonConfigProvider } from './jsonConfigProvider';
import { nodeFilesystem } from './nodeFilesystem';
import { createNodeWorkspace } from './nodeWorkspace';
import { NO_TOOL_AVAILABILITY_HOST } from '../interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '../languageModel';
import { platform } from '../platform';
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  ConfigProvider,
  LifecycleHost,
  StateStore,
  StorageProvider,
  ToolAvailabilityHost,
  ToolMissingHandler,
} from '../interfaces';
import type { LanguageModelPort } from '../languageModel';
import type { Platform } from '../platform';
import type { PlatformSecrets } from '../secrets';

/**
 * Host-specific services a Node host supplies to {@link createNodePlatform}. The
 * shared Node defaults (filesystem, workspace provider, config provider, and
 * the no-op tool-availability host) are filled in by the helper.
 */
export interface NodePlatformServices {
  /**
   * Config source: the workspace + global stores to build the file-backed
   * provider from, or an already-constructed provider for hosts that resolve
   * configuration some other way (the SDK's process-local memory provider, the
   * extension's transition-aware subclass).
   */
  readonly config: JsonConfigProviderOptions | ConfigProvider;
  readonly globalState: StateStore;
  readonly workspaceState: StateStore;
  readonly storage: StorageProvider;
  readonly secrets: PlatformSecrets;
  readonly lifecycle: LifecycleHost;
  readonly agentResume: AgentResumePort;
  readonly agentDirectories: AgentDirectoriesPort;
  /** Current workspace root, read lazily so the host can update it later. */
  readonly getWorkspacePath: () => string | undefined;
  /** Host-specific availability overrides merged over the no-op defaults. */
  readonly toolAvailability?: Partial<ToolAvailabilityHost>;
  /** Editor-host subscription models; defaults to the unavailable port. */
  readonly languageModel?: LanguageModelPort;
  /** Optional process-host capability; absent means no-op (see `Platform`). */
  readonly toolMissingHandler?: ToolMissingHandler;
}

function toConfigProvider(
  config: JsonConfigProviderOptions | ConfigProvider,
): ConfigProvider {
  return 'workspace' in config ? new JsonConfigProvider(config) : config;
}

export interface NodeAgentDirectoryBootstrapOptions {
  readonly channel: string;
  readonly resourcesPath: string;
  readonly currentVersion: string | undefined;
  readonly versionStateKey: string;
}

export interface NodeRuntimeSkillOptions {
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly skillSourceOptions?: SkillSourceOptions;
}

const bootstrappedAgentDirectoryResources = new Map<string, string>();
const agentDirectoryBootstrapMutex = new KeyedMutex<string>();

/**
 * Assemble the platform services for a Node-family host (CLI, desktop,
 * extension) or an SDK embedder.
 *
 * Centralizes the default building blocks every host would otherwise restate
 * in its own `initPlatform` literal (`nodeFilesystem`, `createNodeWorkspace`,
 * `nodeFileLocks`, the config provider, the no-op tool-availability host)
 * while preserving the rule that only composition roots call
 * `initPlatform(...)`.
 */
export function createNodePlatform(services: NodePlatformServices): Platform {
  return {
    config: toConfigProvider(services.config),
    globalState: services.globalState,
    workspaceState: services.workspaceState,
    fs: nodeFilesystem,
    workspace: createNodeWorkspace(services.getWorkspacePath),
    storage: services.storage,
    fileLocks: nodeFileLocks,
    secrets: services.secrets,
    lifecycle: services.lifecycle,
    agentResume: services.agentResume,
    agentDirectories: services.agentDirectories,
    languageModel: services.languageModel ?? UNAVAILABLE_LANGUAGE_MODEL_PORT,
    toolAvailability: {
      ...NO_TOOL_AVAILABILITY_HOST,
      ...services.toolAvailability,
    },
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
  setRuntimeSkillSources(
    defaultSkillSources(
      {
        cwd: options.cwd,
        resourcesPath: options.resourcesPath,
      },
      options.skillSourceOptions,
    ),
  );
}

/**
 * Reconcile packaged agent directories for a host after `initPlatform`.
 *
 * Hosts use different version-state keys, but the resources-path re-entry rule
 * is the same: after a successful reconcile, a process only reconciles a given
 * host channel again when its active packaged resources path changes. Failures
 * are reported and swallowed by `bootstrapPlatformAgentDirectories` so a broken
 * agent directory does not abort startup, and a later call can retry.
 */
export async function bootstrapNodeAgentDirectories(
  options: NodeAgentDirectoryBootstrapOptions,
): Promise<void> {
  const guardKey = `${options.channel}:${options.versionStateKey}`;

  await agentDirectoryBootstrapMutex.runExclusive(guardKey, async () => {
    if (
      bootstrappedAgentDirectoryResources.get(guardKey) ===
      options.resourcesPath
    ) {
      return;
    }

    if (await bootstrapPlatformAgentDirectories(options)) {
      bootstrappedAgentDirectoryResources.set(guardKey, options.resourcesPath);
    }
  });
}
