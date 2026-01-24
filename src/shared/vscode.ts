export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
}

declare const acquireVsCodeApi: () => VSCodeApi;

let cachedApi: VSCodeApi | undefined;

export const getVsCodeApi = (): VSCodeApi => {
  if (!cachedApi) {
    cachedApi = acquireVsCodeApi();
  }
  return cachedApi;
};

export const postMessage = (
  command: string,
  payload: Record<string, unknown> = {},
): void => {
  getVsCodeApi().postMessage({ command, ...payload });
};

export const getWebviewState = <T>(): T | undefined =>
  getVsCodeApi().getState<T>();

export const setWebviewState = (state: unknown): void => {
  getVsCodeApi().setState(state);
};
