import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin.js';
import { installElectronHostBridge } from './hostBridge.js';

const rendererWindow = globalThis as typeof globalThis & {
  addEventListener?: (
    type: 'unload',
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  location?: { origin?: string };
  postMessage?: (message: unknown, targetOrigin: string) => void;
};

installElectronHostBridge({
  exposeInMainWorld: (name, api) => contextBridge.exposeInMainWorld(name, api),
  onHostMessage: (channel, listener) => {
    const handler = (_event: IpcRendererEvent, message: unknown) =>
      listener(message);
    ipcRenderer.on(channel, handler);
    rendererWindow.addEventListener?.(
      'unload',
      () => ipcRenderer.off(channel, handler),
      { once: true },
    );
  },
  postToRenderer: (message) =>
    rendererWindow.postMessage?.(
      message,
      resolvePostMessageTargetOrigin(rendererWindow.location?.origin),
    ),
  sendToMain: (channel, message) => ipcRenderer.send(channel, message),
});
