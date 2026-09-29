// Shared fakes for exercising the host-aware `settingsAccess` accessor. Builds
// the `SettingsStores` shape from the canonical platform fakes so the store
// contract lives in one place (`FakePlatform.ts`) rather than being re-rolled
// per suite.

import { Effect } from 'effect';
import type {
  ConfigProvider,
  StateStore,
  StateReadFailed,
} from '@platform/interfaces';

import type { SettingsStores } from '@shared/config/settingsAccess';
import type { SettingHost } from '@shared/state/stateSettings';

import { FakeConfigProvider, FakeStateStore } from './FakePlatform';

export interface FakeSettingsStores {
  readonly stores: SettingsStores;
  readonly config: FakeConfigProvider;
  readonly workspaceState: FakeStateStore;
  readonly repoState: FakeStateStore;
  readonly globalState: FakeStateStore;
}

export function makeFakeSettingsStores(
  host: SettingHost = 'vscode',
): FakeSettingsStores {
  const config = new FakeConfigProvider();
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

const ABSENT = Symbol('absent');

/**
 * Whether a key is present in a store. Works for both `ConfigProvider` and
 * `StateStore` (neither exposes `has`), so reset/delete assertions can
 * distinguish "deleted" from "wrote the literal default".
 */
export function isStored(
  store: ConfigProvider | StateStore,
  key: string,
): Effect.Effect<boolean, StateReadFailed> {
  const read =
    'inspect' in store
      ? Effect.sync(() => store.get<unknown>(key, ABSENT))
      : store.get(key);
  return Effect.map(read, (value) => value !== ABSENT && value !== undefined);
}
