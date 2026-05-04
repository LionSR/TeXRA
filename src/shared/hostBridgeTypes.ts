/** Global key where host shells expose the webview bridge API. */
export const HOST_BRIDGE_API_KEY = '__texraHostBridgeApi';

/** Minimal host bridge surface used by frontend code. */
export interface HostBridgeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
