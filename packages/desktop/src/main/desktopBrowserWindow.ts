// The Electron shell window of the desktop: its chrome, its first-paint
// presentation and its content. Nothing here knows a project or a session.

import { join } from 'node:path';

import { Effect } from 'effect';
import { app, BrowserWindow, nativeTheme } from 'electron';

/** The window, owned by the scope it opens in. It is already destroyed once
 *  the user closed it; a close that comes from the scope (a failed open, the
 *  process shutting down) takes it with it. */
export const openDesktopBrowserWindow = (options: {
  readonly title: string;
  readonly mainDir: string;
}) =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new BrowserWindow({
          // The task canvas remains useful with a project sidebar and an
          // optional workbench open beside it at the default size.
          width: 1280,
          height: 860,
          minWidth: 860,
          minHeight: 600,
          // Present the window only after Chromium has painted its first
          // frame. Relying on BrowserWindow's implicit show can strand a
          // hidden-inset window behind the launching macOS Space while the app
          // itself is active.
          show: false,
          title: options.title,
          // Frameless chrome. The OS title bar was a dead 28px strip in the
          // app's own color scheme that no amount of theming could reach, and
          // it visually cut the window off from the shell below it.
          //
          // `hiddenInset` (macOS) keeps the traffic-light buttons but removes
          // the bar, so the desktop shell header becomes the drag region. On
          // Windows/Linux, `titleBarOverlay` hands us the same arrangement with
          // system controls drawn over our surface.
          titleBarStyle: 'hiddenInset',
          // Inset the traffic lights so they sit centred in the 48px header
          // rather than crowding its top-left corner.
          ...(process.platform === 'darwin'
            ? { trafficLightPosition: { x: 18, y: 18 } }
            : { titleBarOverlay: true }),
          // Match the operating-system theme before the renderer paints to
          // avoid a contrasting flash behind the frameless window.
          backgroundColor: nativeTheme.shouldUseDarkColors
            ? '#212121'
            : '#f7f7f7',
          webPreferences: {
            preload: join(options.mainDir, '../preload/index.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
          },
        }),
    ),
    (opened) =>
      Effect.sync(() => {
        if (!opened.isDestroyed()) opened.destroy();
      }),
  );

/** Show the window on its first paint and start loading the renderer: last,
 *  once every surface that answers it is wired. */
export function loadDesktopWindow(
  window: BrowserWindow,
  mainDir: string,
): void {
  let presented = false;
  const present = (): void => {
    if (presented || window.isDestroyed()) return;
    presented = true;
    window.center();
    window.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
  };
  window.once('ready-to-show', present);
  window.webContents.once('did-finish-load', () => {
    // `ready-to-show` is not guaranteed when the page is already cached, so
    // keep load completion as an idempotent presentation fallback.
    present();
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(mainDir, '../renderer/index.html'));
  }
}
