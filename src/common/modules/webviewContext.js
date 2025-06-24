export const vscode = acquireVsCodeApi();

export function registerMessageHandlers(handlers) {
  window.addEventListener('message', (event) => {
    const message = event.data;
    const handler = handlers[message.command];
    if (handler) {
      handler(message);
    }
  });
}

export const CHEVRON_UP_CLASS = 'codicon codicon-chevron-up';
export const CHEVRON_DOWN_CLASS = 'codicon codicon-chevron-down';
export const CHEVRON_RIGHT_CLASS = 'codicon codicon-chevron-right';
