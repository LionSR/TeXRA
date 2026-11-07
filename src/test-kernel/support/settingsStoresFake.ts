// Shared fakes for exercising the host-aware `Settings` accessor over
// TeXRA's catalog. Builds
// the `SettingsStores` shape from the canonical platform fakes so the store
// contract lives in one place (`FakePlatform.ts`) rather than being re-rolled
// per suite.

import type { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import type { SettingsStores } from '@shared/config/settings';

import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';

import { fakeConfig, FakeStateStore } from './FakePlatform';

interface FakeSettingsStores {
  readonly stores: SettingsStores;
  readonly config: MemoryConfigProvider;
  readonly workspaceState: FakeStateStore;
  readonly repoState: FakeStateStore;
  readonly globalState: FakeStateStore;
}

export function makeFakeSettingsStores(): FakeSettingsStores {
  const config = fakeConfig({}, TEXRA_SETTINGS.catalog);
  const workspaceState = new FakeStateStore();
  const repoState = new FakeStateStore();
  const globalState = new FakeStateStore();
  return {
    stores: { config, workspaceState, repoState, globalState },
    config,
    workspaceState,
    repoState,
    globalState,
  };
}
