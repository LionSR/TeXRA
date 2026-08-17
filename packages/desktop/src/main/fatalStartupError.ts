import { app, dialog } from 'electron';

let fatalStartupErrorReported = false;

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
    reportFatalDesktopError(error, {
      title: app.isReady()
        ? 'TeXRA encountered a fatal error'
        : 'TeXRA failed to start',
      message: app.isReady()
        ? 'TeXRA hit an unrecoverable error after startup and must close.'
        : 'TeXRA hit a startup error before the desktop window was ready.',
      forceExit: app.isReady(),
    });
  };
  process.on('unhandledRejection', report);

  return () => {
    process.off('unhandledRejection', report);
  };
}

function reportFatalDesktopError(
  error: unknown,
  options: { title: string; message: string; forceExit?: boolean },
): void {
  if (fatalStartupErrorReported) return;
  fatalStartupErrorReported = true;

  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`Fatal TeXRA desktop error:\n${detail}`);

  const showFailureDialog = (): void => {
    if (options.forceExit) {
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
        .finally(() => app.exit(1));
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
