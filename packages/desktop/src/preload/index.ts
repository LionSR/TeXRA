import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

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
import { resolvePostMessageTargetOrigin } from '../shared/postMessageOrigin.js';

// The preload runs in the page's window; this Node-typed build has no DOM
// library, so the binding names the members it uses.
const rendererWindow: {
  addEventListener?: (
    type: 'unload',
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  location?: { origin?: string };
  postMessage?: (message: unknown, targetOrigin: string) => void;
} = globalThis;

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

/** Hands main's pushes on `channel` to `listener` until the page unloads. */
function onHostMessage(
  channel:
    | typeof ELECTRON_WEBVIEW_PUSH_CHANNEL
    | typeof ELECTRON_SESSION_PUSH_CHANNEL,
  listener: (message: unknown) => void,
): void {
  const handler = (_event: IpcRendererEvent, message: unknown) =>
    listener(message);
  ipcRenderer.on(channel, handler);
  rendererWindow.addEventListener?.(
    'unload',
    () => ipcRenderer.off(channel, handler),
    { once: true },
  );
}

let state: unknown;
contextBridge.exposeInMainWorld(HOST_BRIDGE_API_KEY, {
  postMessage: (message) =>
    ipcRenderer.send(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, message),
  getState: () => state,
  setState: (nextState) => {
    state = nextState;
  },
} satisfies HostBridgeApi);
const pushes = heldUntilListening();
contextBridge.exposeInMainWorld(DESKTOP_PUSHES_API_KEY, {
  listening: () =>
    pushes.listen((message) =>
      rendererWindow.postMessage?.(
        message,
        resolvePostMessageTargetOrigin(rendererWindow.location?.origin),
      ),
    ),
} satisfies DesktopPushesApi);
onHostMessage(ELECTRON_WEBVIEW_PUSH_CHANNEL, pushes.push);

const sessionPushes = heldUntilListening();
contextBridge.exposeInMainWorld(SESSION_WIRE_API_KEY, {
  post: (message) =>
    ipcRenderer.send(ELECTRON_SESSION_MESSAGE_CHANNEL, message),
  onMessage: sessionPushes.listen,
} satisfies SessionWireApi);
onHostMessage(ELECTRON_SESSION_PUSH_CHANNEL, sessionPushes.push);
