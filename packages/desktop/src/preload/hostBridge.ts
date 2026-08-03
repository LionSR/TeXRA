import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@shared/hostBridgeTypes.js';

import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '../shared/hostBridgeChannels.js';

export interface ElectronHostBridgeInstallOptions {
  exposeInMainWorld(name: string, api: HostBridgeApi): void;
  onHostMessage(
    channel: typeof ELECTRON_WEBVIEW_PUSH_CHANNEL,
    listener: (message: unknown) => void,
  ): void;
  postToRenderer(message: unknown): void;
  sendToMain(
    channel: typeof ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
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
  return bridge;
}
