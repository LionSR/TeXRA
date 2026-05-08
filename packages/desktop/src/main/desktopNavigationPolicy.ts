import { shell, type WebContents } from 'electron';

const ALLOWED_HTTPS_HOSTS = new Set<string>([
  'github.com',
  'www.github.com',
  'marketplace.visualstudio.com',
  'open-vsx.org',
]);

export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (host === 'texra.ai' || host.endsWith('.texra.ai')) {
    return true;
  }
  if (host.endsWith('.supabase.co')) {
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
  const reportAsyncError =
    options.onAsyncError ?? ((error) => console.error(error));

  webContents.setWindowOpenHandler(({ url }) => {
    routeOrDeny(url, reportAsyncError);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    routeOrDeny(url, reportAsyncError);
  });

  webContents.on('will-redirect', (event, url) => {
    event.preventDefault();
    routeOrDeny(url, reportAsyncError);
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
