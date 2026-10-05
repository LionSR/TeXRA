import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@shared/hostBridgeTypes';
import { installSettingsCatalog } from '@shared/state/stateSettings';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';

import { createFakeHost, installFakeHost } from './setupPlatform';

// Webview modules resolve their host bridge at import time. Production now
// fails fast without one; the kernel harness provides this inert host before
// each suite loads its modules. Suites that inspect posted messages replace it
// with their own bridge at module scope.
const testHostBridge: HostBridgeApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

(globalThis as Record<string, unknown>)[HOST_BRIDGE_API_KEY] = testHostBridge;

// TeXRA's settings catalog, as every host's `installProcessRuntime` installs
// it, so a suite that reads a TeXRA or plugin setting by key needs no runtime.
installSettingsCatalog(TEXRA_SETTINGS);

// Platform and roots only: the session graph family is installed by the
// test file's own imports (`sessionTestUtils`, `defaultSessionTestSetup`),
// after its mocks.
await installFakeHost(createFakeHost());

export {};
