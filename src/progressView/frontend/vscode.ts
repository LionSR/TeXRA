export interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState?: () => unknown;
  setState?: (state: unknown) => void;
}

declare const acquireVsCodeApi: () => VsCodeApi;

export const vscodeApi = acquireVsCodeApi();

export function postMessage(message: unknown): void {
  vscodeApi.postMessage(message);
}
