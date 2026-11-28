import type { WebContents } from 'electron';

import { TEXRA_SITE_URL } from '@ui/copy/guide';

/** The host every guide link the app builds is under. */
const SITE_HOST = new URL(TEXRA_SITE_URL).hostname;

const ALLOWED_HTTPS_HOSTS = new Set<string>([
  'github.com',
  'www.github.com',
  'marketplace.visualstudio.com',
  'open-vsx.org',
]);

export function isAllowedExternalUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  // The site, its docs and its subdomains.
  if (host === SITE_HOST || host.endsWith(`.${SITE_HOST}`)) {
    return true;
  }
  return ALLOWED_HTTPS_HOSTS.has(host);
}

interface DesktopNavigationPolicyOptions {
  /** Opens an allowed link in the browser, reporting its own failure. */
  openExternal: (url: string) => void;
}

/**
 * The window never navigates or opens a window of its own: a link to an
 * allowed host opens in the browser, any other is dropped.
 */
export function installDesktopNavigationPolicy(
  webContents: WebContents,
  { openExternal }: DesktopNavigationPolicyOptions,
): void {
  const openIfAllowed = (url: string): void => {
    if (isAllowedExternalUrl(url)) openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    openIfAllowed(url);
    return { action: 'deny' };
  });

  // will-navigate and will-redirect share one handler.
  const blockAndOpenIfAllowed = (
    event: { preventDefault(): void },
    url: string,
  ): void => {
    event.preventDefault();
    openIfAllowed(url);
  };
  webContents.on('will-navigate', blockAndOpenIfAllowed);
  webContents.on('will-redirect', blockAndOpenIfAllowed);

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
