import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@texra/shared/hostBridgeTypes.js';

import {
  DESKTOP_PUSHES_API_KEY,
  type DesktopPushesApi,
  ELECTRON_SESSION_MESSAGE_CHANNEL,
  ELECTRON_SESSION_PUSH_CHANNEL,
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
  SESSION_WIRE_API_KEY,
  type SessionWireApi,
} from '../shared/hostBridgeChannels.js';

interface ElectronHostBridgeInstallOptions {
  exposeInMainWorld(
    name: string,
    api: HostBridgeApi | SessionWireApi | DesktopPushesApi,
  ): void;
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

/** A push channel whose pushes wait, in order, until the page's listener
 *  exists. Main counts a push delivered once its window is connected, which is
 *  before the page has evaluated; posting then would reach nobody. */
function heldUntilListening() {
  let listener: ((message: unknown) => void) | undefined;
  const held: unknown[] = [];
  return {
    push: (message: unknown) => {
      if (listener) listener(message);
      else held.push(message);
    },
    listen: (next: (message: unknown) => void) => {
      listener = next;
      for (const message of held.splice(0)) next(message);
    },
  };
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
  const pushes = heldUntilListening();
  options.exposeInMainWorld(DESKTOP_PUSHES_API_KEY, {
    listening: () => pushes.listen(options.postToRenderer),
  } satisfies DesktopPushesApi);
  options.onHostMessage(ELECTRON_WEBVIEW_PUSH_CHANNEL, pushes.push);

  const sessionPushes = heldUntilListening();
  options.exposeInMainWorld(SESSION_WIRE_API_KEY, {
    post: (message) =>
      options.sendToMain(ELECTRON_SESSION_MESSAGE_CHANNEL, message),
    onMessage: sessionPushes.listen,
  } satisfies SessionWireApi);
  options.onHostMessage(ELECTRON_SESSION_PUSH_CHANNEL, sessionPushes.push);
  return bridge;
}
