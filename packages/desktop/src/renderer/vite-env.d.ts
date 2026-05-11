/// <reference types="vite/client" />

interface Window {
  texraDesktop?: {
    electronVersion: string;
    hasWorkspace: boolean;
    workspacePath?: string | undefined;
  };
}
