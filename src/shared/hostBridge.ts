import { HOST_BRIDGE_API_KEY, type HostBridgeApi } from './hostBridgeTypes';

declare const acquireVsCodeApi: (() => HostBridgeApi) | undefined;

function resolveHostBridgeApi(): HostBridgeApi {
  const globalScope = globalThis as typeof globalThis & {
    [HOST_BRIDGE_API_KEY]?: HostBridgeApi;
  };

  const existing = globalScope[HOST_BRIDGE_API_KEY];
  if (existing) return existing;

  if (typeof acquireVsCodeApi === 'function') {
    const api = acquireVsCodeApi();
    globalScope[HOST_BRIDGE_API_KEY] = api;
    return api;
  }

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
