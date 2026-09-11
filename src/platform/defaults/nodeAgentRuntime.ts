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
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

// Local file imports
import type { LifecycleHost } from '../interfaces';

/**
 * Register the direct Lean language services for a Node host after
 * `initPlatform`.
 *
 * Call exactly once per process: `registerDirectLeanLanguageServices`
 * registers a singleton and a shutdown handler that would double-register on
 * a second call.
 */
export function initNodeAgentRuntime(lifecycle: LifecycleHost): void {
  registerDirectLeanLanguageServices(lifecycle);
}
