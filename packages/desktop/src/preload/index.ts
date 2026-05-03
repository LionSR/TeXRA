import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('texraDesktop', {
  version: '0.37.8',
});
