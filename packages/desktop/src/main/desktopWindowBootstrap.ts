import {
  bootstrapDesktopWindowLifecycle,
  type DesktopWindowLifecycleWiring,
} from './desktopWindowLifecycle.js';

type DesktopWindowBootstrapOptions = Omit<
  DesktopWindowLifecycleWiring,
  'webContents'
> & {
  window: { webContents: DesktopWindowLifecycleWiring['webContents'] };
};

export function bootstrapDesktopWindow(
  options: DesktopWindowBootstrapOptions,
): void {
  bootstrapDesktopWindowLifecycle({
    ...options,
    webContents: options.window.webContents,
  });
}
