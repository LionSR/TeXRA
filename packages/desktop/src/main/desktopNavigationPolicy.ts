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
  const reportAsyncError = options.onAsyncError ?? defaultReportError;

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

function defaultReportError(error: unknown): void {
  console.error(error);
}
