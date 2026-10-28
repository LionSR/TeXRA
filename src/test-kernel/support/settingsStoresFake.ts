// Shared fakes for exercising the host-aware `Settings` accessor. Builds
// the `SettingsStores` shape from the canonical platform fakes so the store
// contract lives in one place (`FakePlatform.ts`) rather than being re-rolled
// per suite.

import { Effect } from 'effect';
import type { StateStore, StateReadFailed } from '@platform/interfaces';

import type { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import type { SettingsStores } from '@shared/config/settings';
import type { SettingHost } from '@shared/state/stateSettings';

import { fakeConfig, FakeStateStore } from './FakePlatform';

interface FakeSettingsStores {
  readonly stores: SettingsStores;
  readonly config: MemoryConfigProvider;
  readonly workspaceState: FakeStateStore;
  readonly repoState: FakeStateStore;
  readonly globalState: FakeStateStore;
}

export function makeFakeSettingsStores(
  host: SettingHost = 'vscode',
): FakeSettingsStores {
  const config = fakeConfig();
  const workspaceState = new FakeStateStore();
  const repoState = new FakeStateStore();
  const globalState = new FakeStateStore();
  return {
    stores: { host, config, workspaceState, repoState, globalState },
    config,
    workspaceState,
    repoState,
    globalState,
  };
}

/**
 * Whether a key is present in a state store (it exposes no `has`), so
 * reset/delete assertions can distinguish "deleted" from "wrote the literal
 * default".
 */
export function isStored(
  store: StateStore,
  key: string,
): Effect.Effect<boolean, StateReadFailed> {
  return Effect.map(store.get(key), (value) => value !== undefined);
}
