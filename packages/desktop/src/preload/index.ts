import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { installElectronHostBridge } from './hostBridge.js';

const rendererWindow = globalThis as typeof globalThis & {
  addEventListener?: (
    type: 'beforeunload',
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  location?: { origin?: string };
  postMessage?: (message: unknown, targetOrigin: string) => void;
};

function getRendererTargetOrigin(): string {
  const origin = rendererWindow.location?.origin;
  return origin && origin !== 'null' ? origin : '*';
}

installElectronHostBridge({
  exposeInMainWorld: (name, api) => contextBridge.exposeInMainWorld(name, api),
  onHostMessage: (channel, listener) => {
    const handler = (_event: IpcRendererEvent, message: unknown) =>
      listener(message);
    ipcRenderer.on(channel, handler);
    rendererWindow.addEventListener?.(
      'beforeunload',
      () => ipcRenderer.off(channel, handler),
      { once: true },
    );
  },
  postToRenderer: (message) =>
    rendererWindow.postMessage?.(message, getRendererTargetOrigin()),
  sendToMain: (channel, message) => ipcRenderer.send(channel, message),
});

contextBridge.exposeInMainWorld('texraDesktop', {
  electronVersion: process.versions.electron,
  hasWorkspace: hasDesktopWorkspace(),
});

function hasDesktopWorkspace(): boolean {
  return (
    Boolean(process.env.TEXRA_WORKSPACE_PATH?.trim()) ||
    process.argv.includes('--texra-workspace') ||
    process.argv.some((arg) => arg.startsWith('--texra-workspace='))
  );
}
