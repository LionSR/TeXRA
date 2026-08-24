import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@shared/hostBridgeTypes.js';

import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
  ELECTRON_WEBVIEW_STATE_GET_CHANNEL,
  ELECTRON_WEBVIEW_STATE_SET_CHANNEL,
} from '../shared/hostBridgeChannels.js';

export interface ElectronHostBridgeInstallOptions {
  exposeInMainWorld(name: string, api: HostBridgeApi): void;
  getStateFromMain(channel: typeof ELECTRON_WEBVIEW_STATE_GET_CHANNEL): unknown;
  onHostMessage(
    channel: typeof ELECTRON_WEBVIEW_PUSH_CHANNEL,
    listener: (message: unknown) => void,
  ): void;
  postToRenderer(message: unknown): void;
  sendToMain(
    channel: typeof ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
    message: unknown,
  ): void;
  setStateInMain(
    channel: typeof ELECTRON_WEBVIEW_STATE_SET_CHANNEL,
    state: unknown,
  ): unknown;
}

const PERSISTENCE_ERROR = 'Desktop webview state could not be persisted.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStateResult(result: unknown): unknown {
  if (!isRecord(result) || result.ok !== true) return undefined;
  return result.state;
}

function stateWriteSucceeded(result: unknown): boolean {
  return isRecord(result) && result.ok === true;
}

export function installElectronHostBridge(
  options: ElectronHostBridgeInstallOptions,
): HostBridgeApi {
  const bridge: HostBridgeApi = {
    postMessage: (message) =>
      options.sendToMain(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, message),
    getState: () =>
      readStateResult(
        options.getStateFromMain(ELECTRON_WEBVIEW_STATE_GET_CHANNEL),
      ),
    setState: (nextState) => {
      if (
        !stateWriteSucceeded(
          options.setStateInMain(ELECTRON_WEBVIEW_STATE_SET_CHANNEL, nextState),
        )
      ) {
        throw new Error(PERSISTENCE_ERROR);
      }
    },
  };
  options.exposeInMainWorld(HOST_BRIDGE_API_KEY, bridge);
  options.onHostMessage(ELECTRON_WEBVIEW_PUSH_CHANNEL, options.postToRenderer);
  return bridge;
}
