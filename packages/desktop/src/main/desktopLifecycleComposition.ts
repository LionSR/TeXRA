import {
  bootstrapDesktopWindowLifecycle,
  installDesktopBeforeQuitWiring,
  type DesktopWindowLifecycleWiring,
} from './desktopWindowLifecycle.js';

type DesktopWindowLifecycleCompositionOptions = Omit<
  DesktopWindowLifecycleWiring,
  'webContents'
> & {
  window: { webContents: DesktopWindowLifecycleWiring['webContents'] };
};

type DesktopBeforeQuitCompositionOptions = Parameters<
  typeof installDesktopBeforeQuitWiring
>[0];

/**
 * Installs the lifecycle handlers owned by the Electron startup composition.
 * Window and process handlers are installed at their respective startup
 * points, after their dependencies have been created.
 */
export function installDesktopLifecycleComposition(options: {
  window?: DesktopWindowLifecycleCompositionOptions;
  beforeQuit?: DesktopBeforeQuitCompositionOptions;
}): void {
  if (options.window) {
    bootstrapDesktopWindowLifecycle({
      ...options.window,
      webContents: options.window.window.webContents,
    });
  }
  if (options.beforeQuit) installDesktopBeforeQuitWiring(options.beforeQuit);
}
