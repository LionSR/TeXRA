import { app, dialog } from 'electron';

import { formatFatalErrorDetail } from '@texra-ai/worldline/host';
import { DESKTOP_HEADLESS } from './desktopPresentation.js';

/**
 * Set by the first fatal error, from which every path quits the app: a
 * later one is only logged, and a window closing on the way out asks no
 * discard question. The process's own handlers write it, outside any
 * runtime (the runtime may be what failed).
 */
let fatalErrorReported = false;

export function isFatalDesktopShutdownRequested(): boolean {
  return fatalErrorReported;
}

export function reportFatalStartupError(error: unknown): void {
  reportFatalDesktopError(error, {
    title: 'TeXRA failed to start',
    message: 'TeXRA could not start.',
  });
}

/**
 * Installs the fatal post-startup rejection path. Unhandled main-process
 * failures cannot safely continue with a partially-updated Electron state.
 */
export function installPostStartupRejectionHandler(): void {
  const report = (error: unknown) => {
    const ready = app.isReady();
    reportFatalDesktopError(error, {
      title: ready ? 'TeXRA closed unexpectedly' : 'TeXRA failed to start',
      message: ready
        ? 'TeXRA ran into an unrecoverable error and needs to close.'
        : 'TeXRA could not start.',
      forceQuit: ready,
    });
  };
  process.on('unhandledRejection', report);
}

function reportFatalDesktopError(
  error: unknown,
  options: { title: string; message: string; forceQuit?: boolean },
): void {
  const detail = formatFatalErrorDetail(error);
  console.error(`Fatal TeXRA desktop error:\n${detail}`);
  if (fatalErrorReported) return;
  fatalErrorReported = true;

  const showFailureDialog = (): void => {
    if (DESKTOP_HEADLESS) {
      app.exit(1);
      return;
    }
    if (options.forceQuit) {
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
