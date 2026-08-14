/// <reference types="vite/client" />

interface Window {
  texraDesktop?: {
    hasWorkspace: boolean;
    workspacePath?: string | undefined;
  };
}
