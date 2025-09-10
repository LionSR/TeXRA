export const vscode = acquireVsCodeApi();

export function registerMessageHandlers(handlers) {
  const listener = (event) => {
    const message = event.data;
    const handler = handlers[message.command];
    if (handler) {
      handler(message);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
