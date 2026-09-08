import { HOST_BRIDGE_API_KEY, type HostBridgeApi } from './hostBridgeTypes';

/**
 * Every host (VS Code, Electron, the exported trace viewer) installs its
 * bridge at `globalThis[HOST_BRIDGE_API_KEY]` before this bundle loads — see
 * `BaseViewContentProvider.buildWebviewHtml` (VS Code), `installElectronHostBridge`
 * (desktop), and `installTraceHostBridge` (trace viewer).
 */
function resolveHostBridgeApi(): HostBridgeApi {
  const existing = (
    globalThis as typeof globalThis & {
      [HOST_BRIDGE_API_KEY]?: HostBridgeApi;
    }
  )[HOST_BRIDGE_API_KEY];
  if (existing) return existing;

  throw new Error(
    'TeXRA host bridge is unavailable. Webview code must run inside a TeXRA host.',
  );
}

/** Host bridge API instance for the active TeXRA webview host. */
export const hostBridge: HostBridgeApi = resolveHostBridgeApi();

/**
 * Post a command payload to the active webview host.
 */
export function postMessage(
  command: string,
  payload: Record<string, unknown> = {},
): void {
  hostBridge.postMessage({ command, ...payload });
}
