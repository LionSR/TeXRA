import { app, dialog } from 'electron';

let fatalStartupErrorReported = false;

export function reportFatalStartupError(error: unknown): void {
  if (fatalStartupErrorReported) return;
  fatalStartupErrorReported = true;

  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`Fatal TeXRA desktop error:\n${detail}`);

  const showFailureDialog = () => {
    dialog.showErrorBox(
      'TeXRA failed to start',
      [
        'TeXRA hit a startup error before the desktop window was ready.',
        '',
        detail,
      ].join('\n'),
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
