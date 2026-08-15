/**
 * Node host composition helpers.
 *
 * The two Node composition roots (the `texra` CLI runtime and the Electron
 * desktop main process) wire the same platform skeleton and the same
 * post-`initPlatform` agent-runtime registration. This module owns the shared
 * ingredients so the hosts cannot drift; each host still performs the actual
 * `initPlatform(...)` call in its own composition root.
 *
 * This file is a composition helper, not a core platform abstraction: it
 * deliberately reaches "up" into `@agent` and `@tools` for the registration
 * helpers, mirroring what each host's composition root would otherwise inline.
 * Nothing in `@agent` / `@tools` imports it back, so there is no cycle.
 */

// Local imports
import { registerAgentFeatures } from '@agent/features';
import { PathAgentDirectoryBundleSource } from '@agent/index/AgentDirectorySync';
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import {
  defaultSkillSources,
  type SkillSourceOptions,
} from '@skills/skillSources';
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

// Local file imports
import {
  JsonConfigProvider,
  type JsonConfigProviderOptions,
} from './jsonConfigProvider';
import { nodeFileLocks } from './fileLocks';
import { nodeFilesystem } from './nodeFilesystem';
import { createNodeWorkspace } from './nodeWorkspace';
import { NO_TOOL_AVAILABILITY_HOST } from '../interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '../languageModel';
import { platform } from '../platform';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  LifecycleHost,
  StateStore,
  StorageProvider,
  ToolAvailabilityHost,
} from '../interfaces';
import type { Platform } from '../platform';
import type { PlatformSecrets } from '../secrets';

/**
 * Host-specific services a Node host supplies to {@link createNodePlatform}. The
 * shared Node defaults (filesystem, workspace provider, config provider, and
 * the no-op tool-availability host) are filled in by the helper.
 */
export interface NodePlatformServices {
  /** Workspace + optional global config stores backing the config provider. */
  readonly configStores: JsonConfigProviderOptions;
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

/**
 * Assemble the platform services for a Node host (CLI, desktop).
 *
 * Centralizes the default building blocks both hosts pass to `initPlatform`
 * (`nodeFilesystem`, `createNodeWorkspace`, `JsonConfigProvider`, the no-op
 * tool-availability host) while preserving the rule that only composition
 * roots call `initPlatform(...)`.
 */
export function createNodePlatform(services: NodePlatformServices): Platform {
  return {
    config: new JsonConfigProvider(services.configStores),
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
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    toolAvailability: {
      ...NO_TOOL_AVAILABILITY_HOST,
      ...services.toolAvailability,
    },
    // Missing-tool reporting remains an optional process-host capability.
    // Neither Node host has a corresponding UI, so omission is the no-op.
  };
}

/**
 * Register the singleton agent runtime for a Node host after `initPlatform`.
 *
 * Both Node hosts share this exact post-init sequence: the conditional
 * tool-injection features (memory + goal) and the direct Lean language
 * services. Centralized so the hosts cannot drift; the CLI previously skipped
 * `registerAgentFeatures`, silently losing the memory and goal tool
 * injections.
 *
 * Call exactly once per process: `registerAgentFeatures` and
 * `registerDirectLeanLanguageServices` register a singleton / shutdown handler
 * that throws or double-registers on a second call.
 */
export function initNodeAgentRuntime(lifecycle: LifecycleHost): void {
  registerAgentFeatures();
  registerDirectLeanLanguageServices(lifecycle);
}

/**
 * Register runtime skill sources for a Node host.
 *
 * The CLI and desktop hosts use the same precedence: explicit custom roots,
 * project skills, user skills, and bundled skills. The CLI supplies custom and
 * interop options from command-line flags; desktop uses the defaults so it
 * always gets project, user, and bundled runtime skills.
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
 * Reconcile packaged agent directories for a Node host after `initPlatform`.
 *
 * The CLI and desktop hosts use different version-state keys, but the
 * resources-path re-entry rule is the same: a process only reconciles a given
 * host channel again when its active packaged resources path changes.
 */
export async function bootstrapNodeAgentDirectories(
  options: NodeAgentDirectoryBootstrapOptions,
): Promise<void> {
  const guardKey = `${options.channel}:${options.versionStateKey}`;
  if (
    bootstrappedAgentDirectoryResources.get(guardKey) === options.resourcesPath
  ) {
    return;
  }

  const globalState = platform().globalState;
  await bootstrapPlatformAgentDirectories({
    channel: options.channel,
    bundleSource: new PathAgentDirectoryBundleSource(options.resourcesPath),
    currentVersion: options.currentVersion,
    versionStore: {
      get: () => globalState.get<string>(options.versionStateKey),
      update: (version) => globalState.update(options.versionStateKey, version),
    },
  });
  bootstrappedAgentDirectoryResources.set(guardKey, options.resourcesPath);
}
