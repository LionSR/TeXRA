/**
 * Post-`initPlatform` agent-runtime registration for the two Node process
 * hosts (the `texra` CLI runtime and the Electron desktop main process).
 *
 * Split out of `nodeHost.ts` so that module stays free of the direct Lean LSP
 * adapter: the VS Code extension composes its platform from the same
 * `nodeHost` helpers but drives Lean through its own integration, and pulling
 * the adapter into the extension bundle is what previously forced the
 * extension to inline copies of those helpers instead of importing them.
 */

// Local imports
import { registerAgentFeatures } from '@agent/features';
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

// Local file imports
import type { LifecycleHost } from '../interfaces';

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
