import { platform } from '@platform/platform';
import type { SettingsStores } from '@shared/config/settingsAccess';

/**
 * The three platform stores the host-aware {@link SettingsStores} accessor
 * dispatches over, resolved from the active CLI platform. Used by the `/config`
 * panel; `settingsAccess` picks `cliStore ?? store` per entry, so the
 * git-author keys read/write `.texra/config.json` (config) while other
 * state-backed keys use the CLI `state.json` stores.
 */
export function cliSettingsStores(): SettingsStores {
  const active = platform();
  return {
    config: active.config,
    workspaceState: active.workspaceState,
    globalState: active.globalState,
  };
}
