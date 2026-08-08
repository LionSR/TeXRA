import { isAuthCallbackPath } from '@auth/authCallback';
import { tryParseUrl } from '@utils/core';
import {
  isDesktopProtocolUrl,
  TEXRA_PROTOCOL,
  TEXRA_PROTOCOL_SCHEME,
} from '../shared/desktopProtocol.js';

export interface DesktopProtocolCallback {
  rawUrl: string;
  path: string;
  query: string;
}

interface DesktopProtocolCallbackSubscription {
  dispose(): void;
}

type DesktopProtocolCallbackListener = (
  callback: DesktopProtocolCallback,
) => void;

export interface DesktopProtocolCallbackRouter {
  routeUrl(rawUrl: string): boolean;
  routeArgv(argv: readonly string[]): number;
  subscribe(
    listener: DesktopProtocolCallbackListener,
  ): DesktopProtocolCallbackSubscription;
}

export interface DesktopProtocolApp {
  isPackaged: boolean;
  setAsDefaultProtocolClient(
    protocol: string,
    executable?: string,
    args?: string[],
  ): boolean;
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(
    event: 'second-instance',
    listener: (
      event: unknown,
      argv: string[],
      workingDirectory: string,
      additionalData?: unknown,
    ) => void,
  ): void;
  on(
    event: 'open-url',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void;
}

export interface DesktopProtocolLifecycle {
  router: DesktopProtocolCallbackRouter;
  shouldContinue: boolean;
  /** True only for the process holding Electron's single-instance lock. */
  ownsSingleInstanceLock: boolean;
}

export interface InstallDesktopProtocolOptions {
  app: DesktopProtocolApp;
  argv?: readonly string[];
  execPath?: string;
  devAppArg?: string;
  focusMainWindow?: () => void;
  log?: Pick<Console, 'debug' | 'warn'>;
}

export function parseDesktopProtocolCallback(
  rawUrl: string,
): DesktopProtocolCallback | null {
  const url = tryParseUrl(rawUrl);
  if (!url || url.protocol !== TEXRA_PROTOCOL_SCHEME) return null;

  const path = normalizeProtocolPath(url);
  if (!isAuthCallbackPath(path)) return null;

  return {
    rawUrl,
    path,
    query: url.search.slice(1),
  };
}

export function findDesktopProtocolUrls(argv: readonly string[]): string[] {
  return argv.filter((arg) => parseDesktopProtocolCallback(arg) != null);
}

export function createDesktopProtocolCallbackRouter(
  options: {
    log?: Pick<Console, 'debug' | 'warn'>;
  } = {},
): DesktopProtocolCallbackRouter {
  const listeners = new Set<DesktopProtocolCallbackListener>();
  const pendingCallbacks: DesktopProtocolCallback[] = [];

  function deliver(callback: DesktopProtocolCallback): void {
    if (listeners.size === 0) {
      pendingCallbacks.push(callback);
      return;
    }

    for (const listener of listeners) {
      listener(callback);
    }
  }

  function routeUrl(rawUrl: string): boolean {
    const callback = parseDesktopProtocolCallback(rawUrl);
    if (!callback) {
      options.log?.debug?.(
        'Ignoring unsupported desktop protocol callback URL',
      );
      return false;
    }

    deliver(callback);
    return true;
  }

  return {
    routeUrl,

    routeArgv(argv) {
      let routedCount = 0;
      for (const rawUrl of findDesktopProtocolUrls(argv)) {
        if (routeUrl(rawUrl)) routedCount++;
      }
      return routedCount;
    },

    subscribe(listener) {
      listeners.add(listener);
      for (const callback of pendingCallbacks.splice(0)) {
        listener(callback);
      }

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}

export function installDesktopProtocolCallbackLifecycle(
  options: InstallDesktopProtocolOptions,
): DesktopProtocolLifecycle {
  const { app } = options;
  const router = createDesktopProtocolCallbackRouter({ log: options.log });
  const ownsSingleInstanceLock = app.requestSingleInstanceLock();

  if (!ownsSingleInstanceLock) {
    app.quit();
    return { router, shouldContinue: false, ownsSingleInstanceLock };
  }

  registerProtocolClient(options);

  app.on('second-instance', (_event, argv) => {
    router.routeArgv(argv);
    options.focusMainWindow?.();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    const didRoute = router.routeUrl(url);
    if (didRoute || isDesktopProtocolUrl(url)) {
      options.focusMainWindow?.();
    }
  });

  router.routeArgv(options.argv ?? []);

  return { router, shouldContinue: true, ownsSingleInstanceLock };
}

function normalizeProtocolPath(url: URL): string {
  let rawPath = url.pathname && url.pathname !== '/' ? url.pathname : '';
  if (!rawPath && url.hostname) rawPath = `/${url.hostname}`;
  return rawPath.length > 1 && rawPath.endsWith('/')
    ? rawPath.slice(0, -1)
    : rawPath;
}

function registerProtocolClient(options: InstallDesktopProtocolOptions): void {
  const { app, execPath, devAppArg } = options;
  const useDevArgs = !app.isPackaged && execPath && devAppArg;
  const didRegister = useDevArgs
    ? app.setAsDefaultProtocolClient(TEXRA_PROTOCOL, execPath, [devAppArg])
    : app.setAsDefaultProtocolClient(TEXRA_PROTOCOL);

  if (!didRegister) {
    options.log?.warn?.(`Failed to register ${TEXRA_PROTOCOL}:// handler`);
  }
}
