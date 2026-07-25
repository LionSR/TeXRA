// In-app OAuth browser.
//
// Why this exists: `startSignIn` in desktopSupabaseAuth.ts sends the provider
// URL to a host-supplied `openExternalUrl`. Handing that to the system browser
// means the only way back into the app is the `texra://` deep link, which
// requires a registered protocol client. An unpackaged `electron .` run
// registers the *generic Electron binary* (or fails outright), so on a dev
// machine with no packaged TeXRA.app the callback is silently dropped and
// sign-in hangs forever with no error.
//
// Completing the flow in a WebContentsView we own removes that dependency: we
// watch our own navigation events for the `texra://` redirect and feed it
// straight to the protocol router, which is the exact same entry point
// `app.on('open-url')` uses. The OS never has to route anything.
//
// This is a separate BrowserWindow rather than a view inside the main window's
// tab strip on purpose. OAuth pages must own a full viewport (providers reject
// framed/undersized consent screens), the window is modal to the sign-in
// intent, and it must be disposable the instant the callback lands.

import { BrowserWindow, WebContentsView, type WebContents } from 'electron';

import { tryParseUrl } from '@utils/core';

import { TEXRA_PROTOCOL_SCHEME } from '../desktopProtocol.js';

/**
 * Hosts allowed to render inside the auth window. The flow legitimately spans
 * TeXRA's Supabase endpoint plus whichever identity provider the user picked,
 * so this is wider than the app's normal navigation policy — but it is still an
 * allowlist. Anything else is pushed to the system browser, so a redirect
 * injected into the chain cannot render credential-collecting UI inside a
 * window that visually belongs to TeXRA.
 */
const AUTH_HOST_SUFFIXES: readonly string[] = [
  'texra.ai',
  'supabase.co',
  'github.com',
  'githubusercontent.com',
  'google.com',
  'gstatic.com',
  'googleusercontent.com',
  'googleapis.com',
  'accounts.youtube.com',
];

export function isAllowedAuthUrl(rawUrl: string): boolean {
  const parsed = tryParseUrl(rawUrl);
  if (!parsed) return false;
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return AUTH_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** True for the `texra://` redirect that ends the flow. */
export function isAuthCallbackRedirect(rawUrl: string): boolean {
  return tryParseUrl(rawUrl)?.protocol === TEXRA_PROTOCOL_SCHEME;
}

export interface DesktopAuthBrowserOptions {
  /**
   * Receives the intercepted `texra://` callback. Wired to the protocol
   * router's `routeUrl`, so an in-app completion is indistinguishable
   * downstream from an OS-delivered deep link.
   */
  deliverCallback(rawUrl: string): boolean;
  /** Escape hatch for URLs outside {@link AUTH_HOST_SUFFIXES}. */
  openExternalUrl(url: string): Promise<void>;
  /** Parent for modal presentation; the auth window centers on it. */
  getParentWindow(): BrowserWindow | undefined;
  onError?(error: unknown): void;
}

export interface DesktopAuthBrowser {
  /** Opens (or re-targets) the auth window at `url`. */
  open(url: string): Promise<void>;
  /** Closes the window if open. Safe to call when already closed. */
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function createDesktopAuthBrowser(
  options: DesktopAuthBrowserOptions,
): DesktopAuthBrowser {
  let window: BrowserWindow | undefined;
  let view: WebContentsView | undefined;
  const reportError = (error: unknown) => options.onError?.(error);

  function closeWindow(): void {
    const current = window;
    window = undefined;
    view = undefined;
    if (current && !current.isDestroyed()) current.destroy();
  }

  /**
   * Returns true when the URL terminated the flow, meaning the caller must not
   * continue navigating. Checked on both `will-navigate` and
   * `will-redirect`: providers reach the final callback by either route, and
   * `texra://` has no fetchable content, so letting it through would surface a
   * navigation error to the user right as sign-in succeeded.
   */
  function handleNavigation(rawUrl: string): boolean {
    if (isAuthCallbackRedirect(rawUrl)) {
      // Close before delivering. The callback triggers session commit and a UI
      // refresh; leaving a dead OAuth page on screen during that reads as a
      // hang. Delivery is synchronous into the router's queue, so ordering
      // here is safe.
      closeWindow();
      try {
        options.deliverCallback(rawUrl);
      } catch (error) {
        reportError(error);
      }
      return true;
    }
    if (!isAllowedAuthUrl(rawUrl)) {
      // Off-allowlist: hand to the system browser rather than render an
      // unvetted page in TeXRA chrome.
      options.openExternalUrl(rawUrl).catch(reportError);
      return true;
    }
    return false;
  }

  function installPolicy(webContents: WebContents): void {
    webContents.on('will-navigate', (event, url) => {
      if (handleNavigation(url)) event.preventDefault();
    });
    // Providers bounce through 302s; `will-navigate` alone misses those.
    webContents.on('will-redirect', (event, url) => {
      if (handleNavigation(url)) event.preventDefault();
    });
    // Consent screens open help/privacy links in new windows. Route them out
    // rather than spawning unmanaged windows we would then have to police.
    webContents.setWindowOpenHandler(({ url }) => {
      if (isAuthCallbackRedirect(url)) {
        handleNavigation(url);
      } else {
        options.openExternalUrl(url).catch(reportError);
      }
      return { action: 'deny' };
    });
  }

  function createWindow(): BrowserWindow {
    const parent = options.getParentWindow();
    const authWindow = new BrowserWindow({
      width: 520,
      height: 700,
      // Providers block consent screens in undersized viewports.
      minWidth: 420,
      minHeight: 520,
      title: 'Sign in to TeXRA',
      ...(parent && !parent.isDestroyed() ? { parent, modal: false } : {}),
      autoHideMenuBar: true,
      webPreferences: {
        // No preload and no node integration: this renders third-party
        // identity-provider pages, which must never reach TeXRA's IPC surface.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // A dedicated partition keeps provider cookies out of the app session
        // and lets "sign in as a different user" actually present a fresh
        // login instead of silently reusing a cached identity.
        partition: 'persist:texra-auth',
      },
    });

    const authView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: 'persist:texra-auth',
      },
    });
    authWindow.contentView.addChildView(authView);

    const syncBounds = (): void => {
      if (authWindow.isDestroyed()) return;
      const { width, height } = authWindow.getContentBounds();
      authView.setBounds({ x: 0, y: 0, width, height });
    };
    syncBounds();
    authWindow.on('resize', syncBounds);

    installPolicy(authView.webContents);

    authWindow.on('closed', () => {
      // A user-initiated close abandons the attempt. Clear our handles so the
      // next open() builds a fresh window instead of touching a destroyed one.
      if (window === authWindow) {
        window = undefined;
        view = undefined;
      }
    });

    window = authWindow;
    view = authView;
    return authWindow;
  }

  return {
    async open(url) {
      if (!isAllowedAuthUrl(url)) {
        // Never open a non-allowlisted provider URL in app chrome; fall back
        // to the previous external-browser behavior.
        await options.openExternalUrl(url);
        return;
      }
      if (!window || window.isDestroyed()) createWindow();
      const target = view;
      if (!target) return;
      window?.show();
      window?.focus();
      await target.webContents.loadURL(url);
    },

    close: closeWindow,
    isOpen: () => window != null && !window.isDestroyed(),
    dispose: closeWindow,
  };
}
