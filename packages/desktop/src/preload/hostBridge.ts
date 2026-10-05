import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@texra/shared/hostBridgeTypes.js';

import {
  ELECTRON_SESSION_MESSAGE_CHANNEL,
  ELECTRON_SESSION_PUSH_CHANNEL,
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
  SESSION_WIRE_API_KEY,
  type SessionWireApi,
} from '../shared/hostBridgeChannels.js';

interface ElectronHostBridgeInstallOptions {
  exposeInMainWorld(name: string, api: HostBridgeApi | SessionWireApi): void;
  onHostMessage(
    channel:
      | typeof ELECTRON_WEBVIEW_PUSH_CHANNEL
      | typeof ELECTRON_SESSION_PUSH_CHANNEL,
    listener: (message: unknown) => void,
  ): void;
  postToRenderer(message: unknown): void;
  sendToMain(
    channel:
      | typeof ELECTRON_WEBVIEW_MESSAGE_CHANNEL
      | typeof ELECTRON_SESSION_MESSAGE_CHANNEL,
    message: unknown,
  ): void;
}

export function installElectronHostBridge(
  options: ElectronHostBridgeInstallOptions,
): HostBridgeApi {
  let state: unknown;
  const bridge: HostBridgeApi = {
    postMessage: (message) =>
      options.sendToMain(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, message),
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
  };
  options.exposeInMainWorld(HOST_BRIDGE_API_KEY, bridge);
  options.onHostMessage(ELECTRON_WEBVIEW_PUSH_CHANNEL, options.postToRenderer);

  let sessionListener: ((message: unknown) => void) | undefined;
  options.exposeInMainWorld(SESSION_WIRE_API_KEY, {
    post: (message) =>
      options.sendToMain(ELECTRON_SESSION_MESSAGE_CHANNEL, message),
    onMessage: (listener) => {
      sessionListener = listener;
    },
  } satisfies SessionWireApi);
  options.onHostMessage(ELECTRON_SESSION_PUSH_CHANNEL, (message) => {
    if (sessionListener) sessionListener(message);
    else console.warn('[desktop] dropped a session push: no transport yet');
  });
  return bridge;
}
