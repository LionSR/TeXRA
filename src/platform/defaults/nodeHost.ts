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

// Node imports
import { join } from 'node:path';

// Local imports - agent + tools (composition wiring)
import { registerAgentFeatures } from '@agent/features';
import { initializeGoalPrompts } from '@agent/goal/promptLoader';
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

// Local imports - platform
import { JsonConfigProvider } from './jsonConfigProvider';
import { nodeFilesystem } from './nodeFilesystem';
import { createNodeWorkspace } from './nodeWorkspace';
import { NO_TOOL_AVAILABILITY_HOST } from '../interfaces';

// Type imports
import type { JsonConfigProviderOptions } from './jsonConfigProvider';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  LifecycleHost,
  StateStore,
  StorageProvider,
  ToolAvailabilityHost,
  ToolEditApprovalPort,
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
  /**
   * Tool-edit approval handler override.  If omitted, the returned Platform
   * object carries a default that throws — hosts that run agents with tool-use
   * must provide a real handler here, wired either directly (extension) or via a
   * session-scoped indirection (CLI, desktop).
   */
  readonly toolEditApproval?: ToolEditApprovalPort;
}

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
    secrets: services.secrets,
    lifecycle: services.lifecycle,
    agentResume: services.agentResume,
    agentDirectories: services.agentDirectories,
    toolAvailability: {
      ...NO_TOOL_AVAILABILITY_HOST,
      ...services.toolAvailability,
    },
    // Neither Node host has a UI surface for these yet (linter diagnostics,
    // inline criticism, tool-missing/unavailable toasts). These four Platform
    // ports are optional and single-implementer (VS Code only); core call
    // sites already treat an absent port as a no-op, so omitting them here is
    // enough — no per-host stub needed.
    // Default handler throws — a host must override this to support tool-edit
    // approvals.  CLI and desktop override via a session-scoped indirection
    // (see the host's own initPlatform code); the extension wires its native
    // handler directly.
    toolEditApproval:
      services.toolEditApproval ??
      (() => {
        throw new Error(
          'Tool edit approval is not available: no handler has been configured.',
        );
      }),
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
 * Point host-neutral Goal prompts at the active packaged resource bundle.
 *
 * Safe to call repeatedly: the loader replaces the path and clears its cache.
 * CLI validation can re-enter platform init with a different resources path in
 * the same process, so this stays separate from one-shot runtime registration.
 */
export function initializeNodeGoalPrompts(resourcesPath: string): void {
  initializeGoalPrompts(join(resourcesPath, 'goal', 'goal.yaml'));
}
