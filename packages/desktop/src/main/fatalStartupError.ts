import { app, dialog } from 'electron';

let fatalStartupErrorReported = false;
let fatalDesktopShutdownRequested = false;

export function isFatalDesktopShutdownRequested(): boolean {
  return fatalDesktopShutdownRequested;
}

export function reportFatalStartupError(error: unknown): void {
  reportFatalDesktopError(error, {
    title: 'TeXRA failed to start',
    message: 'TeXRA hit a startup error before the desktop window was ready.',
  });
}

/**
 * Installs the fatal post-startup rejection path. Unhandled main-process
 * failures cannot safely continue with a partially-updated Electron state.
 */
export function installPostStartupRejectionHandler(): () => void {
  const report = (error: unknown) => {
    const ready = app.isReady();
    reportFatalDesktopError(error, {
      title: ready
        ? 'TeXRA encountered a fatal error'
        : 'TeXRA failed to start',
      message: ready
        ? 'TeXRA hit an unrecoverable error after startup and must close.'
        : 'TeXRA hit a startup error before the desktop window was ready.',
      forceQuit: ready,
    });
  };
  process.on('unhandledRejection', report);

  return () => {
    process.off('unhandledRejection', report);
  };
}

function reportFatalDesktopError(
  error: unknown,
  options: { title: string; message: string; forceQuit?: boolean },
): void {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`Fatal TeXRA desktop error:\n${detail}`);
  if (fatalStartupErrorReported) return;
  fatalStartupErrorReported = true;

  const showFailureDialog = (): void => {
    if (options.forceQuit) {
      fatalDesktopShutdownRequested = true;
      void dialog
        .showMessageBox({
          type: 'error',
          title: options.title,
          message: options.message,
          detail,
        })
        .catch((dialogError: unknown) => {
          console.error('Failed to display fatal TeXRA error:', dialogError);
        })
        .finally(() => app.quit());
      return;
    }
    dialog.showErrorBox(
      options.title,
      [options.message, '', detail].join('\n'),
    );
    app.quit();
  };

  if (app.isReady()) {
    showFailureDialog();
    return;
  }

  app.once('ready', showFailureDialog);
}

export function installFatalStartupHandlers(): () => void {
  process.on('uncaughtException', reportFatalStartupError);
  process.on('unhandledRejection', reportFatalStartupError);

  return () => {
    process.off('uncaughtException', reportFatalStartupError);
    process.off('unhandledRejection', reportFatalStartupError);
  };
}
