/**
 * Node host composition helpers.
 *
 * The two Node composition roots (the `texra` CLI runtime and the Electron
 * desktop main process) wire the same platform skeleton and the same
 * post-`initPlatform` agent-runtime registration. This module owns that shared
 * sequence so the hosts cannot drift; each host keeps only its genuinely
 * host-specific concerns (secrets, state stores, auth, signal handlers,
 * snapshot store, config migration, ...).
 *
 * This file is a composition helper, not a core platform abstraction: it
 * deliberately reaches "up" into `@agent` and `@tools` to register the agent
 * runtime, mirroring what each host's composition root would otherwise inline.
 * Nothing in `@agent` / `@tools` imports it back, so there is no cycle.
 */

// Node imports
import { join } from 'node:path';

// Local imports - agent + tools (composition wiring)
import { registerAgentFeatures } from '@agent/features';
import { initializeGoalPrompts } from '@agent/goal';
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

// Local imports - platform
import { JsonConfigProvider } from './jsonConfigProvider';
import { nodeFilesystem } from './nodeFilesystem';
import { createNodeWorkspace } from './nodeWorkspace';
import { NO_TOOL_AVAILABILITY_HOST } from '../interfaces/toolAvailability';
import { initPlatform } from '../platform';

// Type imports
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type { AgentResumePort } from '../interfaces/agentResume';
import type { LifecycleHost } from '../interfaces/lifecycle';
import type { StateStore } from '../interfaces/state';
import type { StorageProvider } from '../interfaces/storage';
import type { ToolAvailabilityHost } from '../interfaces/toolAvailability';
import type { PlatformSecrets } from '../secrets';

/**
 * Host-specific services a Node host supplies to {@link initNodePlatform}. The
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
  /** Current workspace root, read lazily so the host can update it later. */
  readonly getWorkspacePath: () => string | undefined;
  /** Host-specific availability overrides merged over the no-op defaults. */
  readonly toolAvailability?: Partial<ToolAvailabilityHost>;
}

/**
 * Assemble and install the platform for a Node host (CLI, desktop).
 *
 * Centralizes the default building blocks both hosts pass to `initPlatform`
 * (`nodeFilesystem`, `createNodeWorkspace`, `JsonConfigProvider`, the no-op
 * tool-availability host) so they cannot diverge between hosts.
 */
export function initNodePlatform(services: NodePlatformServices): void {
  initPlatform({
    config: new JsonConfigProvider(services.configStores),
    globalState: services.globalState,
    workspaceState: services.workspaceState,
    fs: nodeFilesystem,
    workspace: createNodeWorkspace(services.getWorkspacePath),
    storage: services.storage,
    secrets: services.secrets,
    lifecycle: services.lifecycle,
    agentResume: services.agentResume,
    toolAvailability: {
      ...NO_TOOL_AVAILABILITY_HOST,
      ...services.toolAvailability,
    },
  });
}

/**
 * Register the agent runtime for a Node host after {@link initNodePlatform}.
 *
 * Both Node hosts share this exact post-init sequence: the conditional
 * tool-injection features (memory + goal), the direct Lean language services,
 * and the packaged Goal prompt path. Centralized so the hosts cannot drift;
 * the CLI previously skipped `registerAgentFeatures`, silently losing the
 * memory and goal tool injections.
 *
 * Call exactly once per process: `registerAgentFeatures` and
 * `registerDirectLeanLanguageServices` register a singleton / shutdown handler
 * that throws or double-registers on a second call.
 */
export function initNodeAgentRuntime(
  lifecycle: LifecycleHost,
  resourcesPath: string,
): void {
  registerAgentFeatures();
  registerDirectLeanLanguageServices(lifecycle);
  initializeGoalPrompts(join(resourcesPath, 'goal', 'goal.yaml'));
}
