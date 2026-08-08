import { shell, type WebContents } from 'electron';
import { tryParseUrl } from '@utils/core';

import { createDesktopErrorReporter } from './desktopIpcTypes.js';

const ALLOWED_HTTPS_HOSTS = new Set<string>([
  'github.com',
  'www.github.com',
  'marketplace.visualstudio.com',
  'open-vsx.org',
]);

export function isAllowedExternalUrl(url: string): boolean {
  const parsed = tryParseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  // Auth flows hit remote.texra.ai (covered by *.texra.ai). A blanket
  // *.supabase.co rule would let any Supabase project host phishing pages.
  if (host === 'texra.ai' || host.endsWith('.texra.ai')) {
    return true;
  }
  return ALLOWED_HTTPS_HOSTS.has(host);
}

function routeOrDeny(
  url: string,
  onAsyncError: (error: unknown) => void,
): void {
  if (!isAllowedExternalUrl(url)) return;
  shell.openExternal(url).catch(onAsyncError);
}

export interface DesktopNavigationPolicyOptions {
  onAsyncError?: (error: unknown) => void;
}

export function installDesktopNavigationPolicy(
  webContents: WebContents,
  options: DesktopNavigationPolicyOptions = {},
): void {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  webContents.setWindowOpenHandler(({ url }) => {
    routeOrDeny(url, reportAsyncError);
    return { action: 'deny' };
  });

  // will-navigate and will-redirect share one deny-then-route handler.
  const denyAndRoute = (
    event: { preventDefault(): void },
    url: string,
  ): void => {
    event.preventDefault();
    routeOrDeny(url, reportAsyncError);
  };
  webContents.on('will-navigate', denyAndRoute);
  webContents.on('will-redirect', denyAndRoute);

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
