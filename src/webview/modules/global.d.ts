// Global type declarations for webview modules

declare global {
  interface Window {
    updateRecordingUI?: (recording: boolean) => void;
    _skipNextRestoreState?: boolean;
  }
}

export {};
