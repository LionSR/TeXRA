import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import type { SettingsStores } from '@shared/config/settingsAccess';

/**
 * The three stores the host-aware {@link SettingsStores} accessor dispatches
 * over: the workspace config and state of the calling context's roots, and
 * the process global state. Used by the `/config` panel; `settingsAccess`
 * resolves `entry.slots.cli` per row, so the git-author keys read/write
 * `.texra/config.json` (config) while other state-backed keys use the CLI
 * `state.json` stores.
 */
export function cliSettingsStores(): SettingsStores {
  const { config, workspaceState } = workspaceRoots();
  return { config, workspaceState, globalState: platform().globalState };
}
