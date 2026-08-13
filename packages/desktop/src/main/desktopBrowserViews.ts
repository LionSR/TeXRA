// Embedded browser tabs.
//
// Web content renders in a main-process WebContentsView layered over the
// renderer window rather than an <iframe> or <webview> inside the renderer:
//
//   - <iframe> is blocked by X-Frame-Options / frame-ancestors on most of the
//     pages users actually want (GitHub, docs portals, provider consent pages).
//   - <webview> is discouraged by Electron and carries its own lifecycle bugs.
//   - BrowserView is deprecated in favor of WebContentsView.
//
// The cost is that a view is not part of renderer layout: it is positioned by
// absolute pixel bounds the renderer measures and reports. The renderer draws a
// placeholder rectangle (#desktop-browser-slot) and sends its geometry, and the
// view is hidden by removing it from the window rather than by CSS.

import {
  WebContentsView,
  type BaseWindow,
  type Rectangle,
  type WebContents,
} from 'electron';

import { tryParseUrl } from '@utils/core';

export interface DesktopBrowserViewsOptions {
  getWindow(): BaseWindow | undefined;
  /** Opens a URL outside the app (used for schemes we refuse to embed). */
  openExternalUrl(url: string): Promise<void>;
  /** Reports navigation state so the renderer can update its URL bar. */
  onNavigated(input: {
    tabId: string;
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
  }): void;
  onError?(error: unknown): void;
}

export interface DesktopBrowserViews {
  /** Creates (or reuses) the view for `tabId` and loads `url`. */
  open(tabId: string, url: string): void;
  /** Shows one tab's view at `bounds` and detaches every other view. */
  show(tabId: string, bounds: Rectangle): void;
  /** Detaches all views, e.g. when a non-browser tab becomes active. */
  hideAll(): void;
  navigate(tabId: string, url: string): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  close(tabId: string): void;
  disposeAll(): void;
}

/**
 * Only http(s) is embeddable. Anything else — `file:` (local disk read),
 * `javascript:` (script injection), custom schemes — is refused rather than
 * loaded into a view that renders inside TeXRA's own window.
 */
function isEmbeddableUrl(rawUrl: string): boolean {
  const parsed = tryParseUrl(rawUrl);
  return parsed?.protocol === 'https:' || parsed?.protocol === 'http:';
}

/**
 * The only non-web scheme that the embedded browser may hand to the OS. This
 * is a different policy from `desktopNavigationPolicy.isAllowedExternalUrl`,
 * which governs which https hosts the app's own window may open externally.
 */
function isHandOffableUrl(rawUrl: string): boolean {
  return tryParseUrl(rawUrl)?.protocol === 'mailto:';
}

export function createDesktopBrowserViews(
  options: DesktopBrowserViewsOptions,
): DesktopBrowserViews {
  const views = new Map<string, WebContentsView>();
  let attachedTabId: string | undefined;

  const reportError = (error: unknown) => options.onError?.(error);

  function openAllowedExternalUrl(url: string): void {
    if (!isHandOffableUrl(url)) {
      reportError(new Error(`Blocked external browser URL: ${url}`));
      return;
    }
    options.openExternalUrl(url).catch(reportError);
  }

  function publishState(tabId: string, view: WebContentsView): void {
    const { webContents } = view;
    if (webContents.isDestroyed()) return;
    options.onNavigated({
      tabId,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
      loading: webContents.isLoading(),
    });
  }

  function installPolicy(tabId: string, webContents: WebContents): void {
    // Links that would open a new window become new browser tabs' business;
    // here they load in place so a click can't spawn unmanaged chrome.
    webContents.setWindowOpenHandler(({ url }) => {
      if (isEmbeddableUrl(url)) {
        webContents.loadURL(url).catch(reportError);
      } else {
        openAllowedExternalUrl(url);
      }
      return { action: 'deny' };
    });
    webContents.on('will-navigate', (event, url) => {
      if (isEmbeddableUrl(url)) return;
      event.preventDefault();
      openAllowedExternalUrl(url);
    });
    // Registered one at a time rather than in a loop: `WebContents.on` is a
    // union of per-event overloads, so a loop variable collapses to the last
    // signature and stops type-checking.
    const republish = (): void => {
      const view = views.get(tabId);
      if (view) publishState(tabId, view);
    };
    webContents.on('did-navigate', republish);
    webContents.on('did-navigate-in-page', republish);
    webContents.on('did-finish-load', republish);
    webContents.on('did-stop-loading', republish);
    webContents.on('page-title-updated', republish);
  }

  function ensureView(tabId: string): WebContentsView {
    const existing = views.get(tabId);
    if (existing && !existing.webContents.isDestroyed()) return existing;

    const view = new WebContentsView({
      webPreferences: {
        // Arbitrary web content: no preload, no node, sandboxed. It must never
        // reach TeXRA's IPC surface.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // Shared partition so browser tabs behave like one browser profile
        // (a login in one tab carries to another), kept separate from the
        // dedicated auth partition.
        partition: 'persist:texra-browser',
      },
    });
    view.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    view.webContents.session.setPermissionCheckHandler(() => false);
    installPolicy(tabId, view.webContents);
    views.set(tabId, view);
    return view;
  }

  function detachAll(): void {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return;
    for (const view of views.values()) {
      // removeChildView on a view that isn't attached is a no-op, so this
      // doesn't need to track attachment per view.
      window.contentView.removeChildView(view);
    }
    attachedTabId = undefined;
  }

  function closeTabView(tabId: string): void {
    const view = views.get(tabId);
    if (!view) return;
    const window = options.getWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(view);
    }
    if (attachedTabId === tabId) attachedTabId = undefined;
    views.delete(tabId);
    // Closing the tab must tear down its web contents, or the page keeps
    // running (timers, media, network) with no way to reach it.
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  return {
    open(tabId, url) {
      if (!isEmbeddableUrl(url)) {
        openAllowedExternalUrl(url);
        return;
      }
      const view = ensureView(tabId);
      view.webContents.loadURL(url).catch(reportError);
    },

    show(tabId, bounds) {
      const window = options.getWindow();
      if (!window || window.isDestroyed()) return;
      const view = views.get(tabId);
      if (!view) return;
      if (attachedTabId !== tabId) {
        detachAll();
        window.contentView.addChildView(view);
        attachedTabId = tabId;
      }
      view.setBounds(bounds);
      publishState(tabId, view);
    },

    hideAll: detachAll,

    navigate(tabId, url) {
      if (!isEmbeddableUrl(url)) {
        openAllowedExternalUrl(url);
        return;
      }
      views.get(tabId)?.webContents.loadURL(url).catch(reportError);
    },

    goBack(tabId) {
      const history = views.get(tabId)?.webContents.navigationHistory;
      if (history?.canGoBack()) history.goBack();
    },

    goForward(tabId) {
      const history = views.get(tabId)?.webContents.navigationHistory;
      if (history?.canGoForward()) history.goForward();
    },

    reload(tabId) {
      views.get(tabId)?.webContents.reload();
    },

    close: closeTabView,

    disposeAll() {
      // Snapshot the keys: closeTabView mutates `views` as it goes.
      for (const tabId of [...views.keys()]) closeTabView(tabId);
    },
  };
}
