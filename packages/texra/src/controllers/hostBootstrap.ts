/**
 * The once-per-process bootstrap that sits beside each composition root's
 * `processLayer()`, the same for every host: the VS Code extension, the
 * Electron main process and the `texra` CLI each run it once their process
 * roots exist, so there is one place to read what a started TeXRA process
 * writes beyond its runtime.
 *
 * Nothing here reads an ambient host: the one state write takes its store
 * as an argument, and the plugin list is the runtime's own `ToolRegistry`.
 * The CLI keeps its roots and lazy session private until this fallible
 * setup has succeeded, and the first-install seed below is the fallible step
 * that invariant was written for.
 *
 * What stays with the caller: the process runtime install (which serves the
 * host's skill sources, `ProcessLayerOptions.skills`), the `WorkspaceRoots`
 * (each host resolves its config stores differently, and the CLI opens its
 * process session over the roots before this runs), and the host's
 * shutdown: a scope whose finalizers close every session, then the host's
 * own resources, then the runtime, each host registering the resources only
 * it holds.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { ToolRegistry } from '@texra-ai/harness/plugins';
import { type WorkspaceRoots } from '@texra-ai/harness';
import { seedDisabledToolDefaults } from '@texra-ai/harness/host';

export interface HostBootstrapInit {
  /**
   * The process roots the root just built: the global state store the
   * first-install seed writes to.
   */
  readonly roots: WorkspaceRoots;
}

/**
 * Everything a TeXRA process writes once beside its platform.
 *
 * Runs on the composition root's own process runtime: the first-install tool
 * seed is a state write, and the root that just installed that runtime is the
 * one that runs this.
 */
export const bootstrapHost = Effect.fn('bootstrapHost')(function* (
  init: HostBootstrapInit,
) {
  // Seed first-install defaults (e.g. disabled tools). No-ops once
  // DISABLED_TOOLS exists, so upgrading users keep the tools they enabled.
  yield* seedDisabledToolDefaults(init.roots.globalState, [
    ...(yield* ToolRegistry).entries.values(),
  ]);
});
