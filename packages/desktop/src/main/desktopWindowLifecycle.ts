import { Effect } from 'effect';

interface EventSource {
  on(
    event: string,
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
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

interface DesktopWindowLifecycleWiring {
  webContents: EventSource;
  /** The document reloaded: whatever it held is released. */
  onDocumentReloaded(): void;
  showDiscardDialog(): number;
  isFatalShutdownRequested(): boolean;
  clearContinueQuitAfterWindowClose(): void;
}

export function bootstrapDesktopWindowLifecycle(
  options: DesktopWindowLifecycleWiring,
): void {
  options.webContents.on('will-prevent-unload', (event) => {
    if (
      options.isFatalShutdownRequested() ||
      options.showDiscardDialog() === 1
    ) {
      event.preventDefault();
      return;
    }
    options.clearContinueQuitAfterWindowClose();
  });

  let initialRendererNavigationComplete = false;
  options.webContents.on('did-navigate', () => {
    if (!initialRendererNavigationComplete) {
      initialRendererNavigationComplete = true;
      return;
    }
    // Switching projects changes visibility and never navigates the
    // document, so this is a real reload.
    options.onDocumentReloaded();
  });
}

export function installDesktopBeforeQuitWiring(options: {
  app: BeforeQuitApp;
  getMainWindow(): MainWindow | null;
  /** The process's shutdown, which closes the process scope. */
  shutdown: Effect.Effect<void>;
  continueAfterWindowClose(continueQuit: () => void): void;
}): void {
  let quitPhase: 'idle' | 'draining' | 'ready' = 'idle';
  options.app.on('before-quit', (event) => {
    if (quitPhase === 'ready') return;
    event.preventDefault();
    if (quitPhase === 'draining') return;
    const window = options.getMainWindow();
    if (window && !window.isDestroyed()) {
      options.continueAfterWindowClose(() => {
        if (quitPhase === 'idle') options.app.quit();
      });
      window.close();
      return;
    }
    // Claim the drain before starting it. Its continuation allows Electron's
    // reentrant before-quit event to proceed.
    quitPhase = 'draining';
    void Effect.runPromise(
      options.shutdown.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            quitPhase = 'ready';
            options.app.quit();
          }),
        ),
      ),
    );
  });
}
