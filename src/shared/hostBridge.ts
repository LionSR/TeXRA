// Local types
/** Minimal host bridge surface used by frontend code. */
export interface HostBridgeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export type VSCodeApi = HostBridgeApi;

declare const acquireVsCodeApi: (() => HostBridgeApi) | undefined;

const API_KEY = '__texraHostBridgeApi';
const LEGACY_API_KEY = '__texraVscodeApi';

const fallbackApi: HostBridgeApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

function resolveHostBridgeApi(): HostBridgeApi {
  const globalScope = globalThis as typeof globalThis & {
    [API_KEY]?: HostBridgeApi;
    [LEGACY_API_KEY]?: HostBridgeApi;
  };

  if (globalScope[API_KEY]) {
    return globalScope[API_KEY] as HostBridgeApi;
  }

  if (globalScope[LEGACY_API_KEY]) {
    globalScope[API_KEY] = globalScope[LEGACY_API_KEY];
    return globalScope[API_KEY] as HostBridgeApi;
  }

  if (typeof acquireVsCodeApi === 'function') {
    const api = acquireVsCodeApi();
    globalScope[API_KEY] = api;
    return api;
  }

  return fallbackApi;
}

/** Host bridge API instance (falls back to no-op in non-webview contexts). */
export const hostBridge: HostBridgeApi = resolveHostBridgeApi();

/** @deprecated Use `hostBridge` from `@shared/hostBridge`. */
export const vscode: HostBridgeApi = hostBridge;

/**
 * Post a command payload to the active webview host.
 */
export function postMessage(
  command: string,
  payload: Record<string, unknown> = {},
): void {
  hostBridge.postMessage({ command, ...payload });
}
