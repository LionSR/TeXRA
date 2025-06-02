export function registerMessageHandlers(handlers) {
  window.addEventListener('message', (event) => {
    const message = event.data;
    const handler = handlers[message.command];
    if (handler) {
      handler(message);
    }
  });
}
