export const vscode = acquireVsCodeApi();

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
