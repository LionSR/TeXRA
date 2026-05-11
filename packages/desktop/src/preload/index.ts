import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { installElectronHostBridge } from './hostBridge.js';
import { hasResolvedWorkspacePath } from '../workspacePath.js';

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

function getWorkspacePath(): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--texra-workspace-path') {
      const value = argv[i + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
    if (arg?.startsWith('--texra-workspace-path=')) {
      return arg.slice('--texra-workspace-path='.length) || undefined;
    }
  }
  return undefined;
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
  hasWorkspace: hasResolvedWorkspacePath(),
  workspacePath: getWorkspacePath(),
});
