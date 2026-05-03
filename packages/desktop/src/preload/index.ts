import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('texraDesktop', {
  electronVersion: process.versions.electron,
});
