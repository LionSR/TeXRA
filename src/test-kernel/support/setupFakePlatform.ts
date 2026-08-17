import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@shared/hostBridgeTypes';

import { installPlatform } from './setupPlatform';

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

await installPlatform();

export {};
