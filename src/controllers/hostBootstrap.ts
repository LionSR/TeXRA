/**
 * The once-per-process bootstrap that sits beside `initPlatform()`, in one
 * order for every host.
 *
 * Each composition root still builds its own `Platform` literal and makes its
 * own `initPlatform()` call — every field of the literal is host-specific and
 * ESLint pins the call to the roots. What surrounded that call was not
 * host-specific at all: the VS Code extension, the Electron main process and
 * the `texra` CLI each performed the same process-wide installs in three
 * different orders, every body carrying a comment claiming to mirror one of
 * the other two. This module owns that order, so the three roots cannot drift
 * and there is one place to read what a started TeXRA process has installed.
 *
 * Nothing here reads `platform()`: every step either sets a module-global or
 * registers a closure that resolves later, and the one state write takes its
 * store as an argument. So the extension and the desktop run it straight
 * after `initPlatform()`, while the CLI runs it just before — that host keeps
 * its platform, roots and lazy session private until the fallible setup has
 * succeeded, and the first-install seed below is the fallible step that
 * invariant was written for.
 *
 * What stays with the caller: the `Platform` literal and `initPlatform()`, the
 * `WorkspaceRoots` (each host resolves its config stores differently, and the
 * CLI opens its process session over the roots before this runs), and
 * `registerRuntimeShutdownHandlers` — its hook record names host-owned
 * resources (the desktop's project registry, the extension's session), and the
 * shutdown *order* already has one owner in `@tools/agentCliSessionStores`.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { setDebugModeConfig } from '@logger/logUtils';
import {
  initializeNodeRuntimeSkills,
  type NodeRuntimeSkillOptions,
} from '@platform/defaults/nodeHost';
import { installLongRunningModelDispatcher } from '@platform/defaults/longRunningModelTransport';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SettingHost } from '@shared/schemas';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { initProcessSettingHost } from '@utils/config/platformSettings';

// Local file imports
import { installTexraAccountProbes } from './modelAccess/installTexraAccountProbes';

export interface HostBootstrapInit {
  /**
   * Which host this process is, for the catalog rows whose storage slot
   * differs by host. One process is one host.
   */
  readonly host: SettingHost;
  /**
   * The process roots the root just built: the config provider the debug-mode
   * read is taken over, and the global state store the first-install seed
   * writes to.
   */
  readonly roots: WorkspaceRoots;
  /**
   * The secret store this root opened. The account probes close over it, so
   * the model layer stays secrets-free.
   */
  readonly secrets: PlatformSecrets;
  /** The bundled resources tree (and the CLI's flag-supplied source options). */
  readonly skills: NodeRuntimeSkillOptions;
}

/**
 * Everything a TeXRA process installs once beside its platform.
 *
 * Runs on the composition root's own process runtime: the first-install tool
 * seed is a state write, and the root that just installed that runtime is the
 * one that runs this.
 */
export const bootstrapHost = Effect.fn('bootstrapHost')(function* (
  init: HostBootstrapInit,
) {
  // The process's HTTP dispatcher for model traffic (proxy policy plus the
  // long-stream timeouts). Installed before any model call, which cannot
  // happen until a session is open.
  installLongRunningModelDispatcher();
  initProcessSettingHost(init.host);
  // The logger's process-wide debug-mode read, over this host's configuration.
  setDebugModeConfig(init.roots.config);
  // TeXRA's account plane (ChatGPT / Grok sign-in). Without this the model
  // layer is bring-your-own-key. See installTexraAccountProbes.
  installTexraAccountProbes(init.secrets);
  // Project skills follow each session's workspace; only the bundle is fixed
  // here, so this is a registration rather than a scan.
  initializeNodeRuntimeSkills(init.skills);
  // Seed first-install defaults (e.g. disabled tools). No-ops once
  // DISABLED_TOOLS exists, so upgrading users keep the tools they enabled.
  yield* seedDisabledToolDefaults(init.roots.globalState);
});
