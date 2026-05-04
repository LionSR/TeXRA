import { contextBridge, ipcRenderer } from 'electron';

import { installElectronHostBridge } from './hostBridge.js';

const rendererWindow = globalThis as typeof globalThis & {
  postMessage?: (message: unknown, targetOrigin: string) => void;
};

installElectronHostBridge({
  exposeInMainWorld: (name, api) => contextBridge.exposeInMainWorld(name, api),
  onHostMessage: (channel, listener) => {
    ipcRenderer.on(channel, (_event, message: unknown) => listener(message));
  },
  postToRenderer: (message) => rendererWindow.postMessage?.(message, '*'),
  sendToMain: (channel, message) => ipcRenderer.send(channel, message),
});

contextBridge.exposeInMainWorld('texraDesktop', {
  electronVersion: process.versions.electron,
});
