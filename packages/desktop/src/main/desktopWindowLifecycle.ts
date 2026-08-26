interface EventSource {
  on(
    event: string,
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
}

interface DisposableRendererResources {
  disposeRendererResources(): void;
}

interface ShutdownLifecycle {
  runShutdown(): Promise<void>;
}

interface MainWindow {
  close(): void;
  isDestroyed(): boolean;
}

interface BeforeQuitEvent {
  preventDefault(): void;
}

interface BeforeQuitApp {
  on(event: 'before-quit', listener: (event: BeforeQuitEvent) => void): void;
  quit(): void;
}

function installRendererNavigationCleanup(
  webContents: EventSource,
  workspaceIpc: DisposableRendererResources,
): void {
  let initialRendererNavigationComplete = false;
  webContents.on('did-navigate', () => {
    if (!initialRendererNavigationComplete) {
      initialRendererNavigationComplete = true;
      return;
    }
    workspaceIpc.disposeRendererResources();
  });
}

function installBeforeQuitHandler(options: {
  app: BeforeQuitApp;
  getMainWindow(): MainWindow | null;
  lifecycle: ShutdownLifecycle;
  continueAfterWindowClose(continueQuit: () => void): void;
}): void {
  let shutdownStarted = false;
  let quitting = false;
  options.app.on('before-quit', (event) => {
    if (quitting) return;
    const window = options.getMainWindow();
    if (window && !window.isDestroyed()) {
      event.preventDefault();
      options.continueAfterWindowClose(() => options.app.quit());
      window.close();
      return;
    }
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void options.lifecycle.runShutdown().finally(() => {
      quitting = true;
      options.app.quit();
    });
  });
}

export function installDesktopBeforeQuitWiring(options: {
  app: BeforeQuitApp;
  getMainWindow(): MainWindow | null;
  lifecycle: ShutdownLifecycle;
  continueAfterWindowClose(continueQuit: () => void): void;
}): void {
  installBeforeQuitHandler(options);
}

export interface DesktopWindowLifecycleWiring {
  webContents: EventSource;
  workspaceIpc: DisposableRendererResources;
  showDiscardDialog(): number;
  isFatalShutdownRequested(): boolean;
  clearPendingWorkspaceRelaunch(): void;
  clearContinueQuitAfterWindowClose(): void;
}

function installUnsavedChangesHandler(options: {
  webContents: EventSource;
  showDiscardDialog(): number;
  isFatalShutdownRequested(): boolean;
  clearPendingWorkspaceRelaunch(): void;
  clearContinueQuitAfterWindowClose(): void;
}): void {
  options.webContents.on('will-prevent-unload', (event) => {
    if (options.isFatalShutdownRequested()) {
      options.clearPendingWorkspaceRelaunch();
      event.preventDefault();
      return;
    }
    if (options.showDiscardDialog() === 1) {
      event.preventDefault();
      return;
    }
    options.clearPendingWorkspaceRelaunch();
    options.clearContinueQuitAfterWindowClose();
  });
}

export function installDesktopWindowLifecycleWiring(
  options: DesktopWindowLifecycleWiring,
): void {
  installUnsavedChangesHandler(options);
  installRendererNavigationCleanup(options.webContents, options.workspaceIpc);
}
