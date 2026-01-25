// Local types
/** Minimal VS Code webview API surface used by frontend code. */
export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare const acquireVsCodeApi: (() => VSCodeApi) | undefined;

const API_KEY = '__texraVscodeApi';

const fallbackApi: VSCodeApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

function resolveVsCodeApi(): VSCodeApi {
  const globalScope = globalThis as typeof globalThis & {
    [API_KEY]?: VSCodeApi;
  };

  if (globalScope[API_KEY]) {
    return globalScope[API_KEY] as VSCodeApi;
  }

  if (typeof acquireVsCodeApi === 'function') {
    const api = acquireVsCodeApi();
    globalScope[API_KEY] = api;
    return api;
  }

  return fallbackApi;
}

/** VS Code API instance (falls back to no-op in non-webview contexts). */
export const vscode: VSCodeApi = resolveVsCodeApi();

/**
 * Post a command payload to the VS Code webview host.
 */
export function postMessage(
  command: string,
  payload: Record<string, unknown> = {},
): void {
  vscode.postMessage({ command, ...payload });
}
