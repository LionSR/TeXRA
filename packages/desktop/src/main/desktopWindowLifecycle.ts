import { Effect } from 'effect';

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
  /** The platform's drain (`LifecycleHost.runShutdown`): it drains both
   *  phases once and a later caller joins the drain in flight, so this
   *  wiring keeps no "shutdown started" flag of its own. */
  readonly runShutdown: Effect.Effect<void>;
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
  workspaceIpc: DisposableRendererResources;
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
    // A real document reload releases its resources. Switching papers
    // changes visibility and never navigates the document.
    options.workspaceIpc.disposeRendererResources();
  });
}

export function installDesktopBeforeQuitWiring(options: {
  app: BeforeQuitApp;
  getMainWindow(): MainWindow | null;
  lifecycle: ShutdownLifecycle;
  continueAfterWindowClose(continueQuit: () => void): void;
}): void {
  let quitting = false;
  options.app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    const window = options.getMainWindow();
    if (window && !window.isDestroyed()) {
      options.continueAfterWindowClose(() => options.app.quit());
      window.close();
      return;
    }
    // Electron's before-quit is this host's R1 entry, so the drain is run
    // here and the quit follows it however it ends. A before-quit arriving
    // while the drain is in flight joins that same drain, and `quitting`
    // arbitrates the quit the join lands on.
    void Effect.runPromise(
      options.lifecycle.runShutdown.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            quitting = true;
            options.app.quit();
          }),
        ),
      ),
    );
  });
}
