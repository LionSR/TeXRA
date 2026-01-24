// Local types
export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare const acquireVsCodeApi: () => VSCodeApi;

export const vscode: VSCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: () => undefined,
        getState: () => undefined,
        setState: () => undefined,
      };

export function postMessage(command: string, payload: Record<string, unknown>) {
  vscode.postMessage({ command, ...payload });
}
