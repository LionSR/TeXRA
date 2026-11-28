import type { WebContents } from 'electron';

interface DesktopNavigationPolicyOptions {
  /** Opens a web address in the browser, reporting its own failure. */
  openExternal: (url: string) => void;
}

/**
 * The window never navigates or opens a window of its own: a web link, to
 * any host, opens in the user's browser, and an address of any other scheme
 * is dropped.
 */
export function installDesktopNavigationPolicy(
  webContents: WebContents,
  { openExternal }: DesktopNavigationPolicyOptions,
): void {
  const openWebLink = (url: string): void => {
    const protocol = URL.parse(url)?.protocol;
    if (protocol === 'http:' || protocol === 'https:') openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: 'deny' };
  });

  // will-navigate and will-redirect share one handler.
  const blockAndOpen = (
    event: { preventDefault(): void },
    url: string,
  ): void => {
    event.preventDefault();
    openWebLink(url);
  };
  webContents.on('will-navigate', blockAndOpen);
  webContents.on('will-redirect', blockAndOpen);

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
