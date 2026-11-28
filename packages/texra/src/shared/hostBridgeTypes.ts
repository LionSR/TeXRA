/** Global key where host shells expose the webview bridge API. */
export const HOST_BRIDGE_API_KEY = '__texraHostBridgeApi';

/** Minimal host bridge surface used by frontend code. */
export interface HostBridgeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
  /**
   * The absolute path of a file dropped from the operating system, or `''`
   * for one that is not on disk. Only a host that can name it has this: the
   * desktop app does, and a VS Code webview's drops carry file URIs instead.
   */
  filePath?(file: File): string;
}

// Where every host installs its bridge (`HOST_BRIDGE_API_KEY`).
declare global {
  var __texraHostBridgeApi: HostBridgeApi | undefined;
}
