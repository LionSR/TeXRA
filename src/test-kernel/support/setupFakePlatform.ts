import { beforeAll } from 'vitest';

import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@texra/shared/hostBridgeTypes';

import {
  bindFakeHost,
  createFakeHost,
  installedHost,
  installFakeHost,
} from './setupPlatform';

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

// The host and its roots now, for the modules a suite evaluates as it loads;
// the process services once the suite is collected, so they compose over its
// `vi.mock` registrations. The session graph family is installed by the test
// file's own imports (`sessionTestUtils`, `defaultSessionTestSetup`), after
// its mocks.
await bindFakeHost(createFakeHost());
beforeAll(() => installFakeHost(installedHost()));

export {};
