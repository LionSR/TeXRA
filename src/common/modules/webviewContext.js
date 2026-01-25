const API_KEY = '__texraVscodeApi';

const fallbackApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

const globalScope = globalThis;
if (!globalScope[API_KEY]) {
  globalScope[API_KEY] =
    typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : fallbackApi;
}

export const vscode = globalScope[API_KEY];

export function registerMessageHandlers(handlers) {
  const listener = (event) => {
    const message = event.data;
    if (!message?.command) {
      return;
    }
    const handler = handlers[message.command];
    if (handler) {
      try {
        handler(message);
      } catch (error) {
        console.error(`[MessageHandler] Error in ${message.command}:`, error);
      }
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
