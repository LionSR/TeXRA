import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopProtocolCallbackRouter,
  findDesktopProtocolUrls,
  installDesktopProtocolCallbackLifecycle,
  parseDesktopProtocolCallback,
  type DesktopProtocolApp,
} from '@desktop/main/desktopProtocolCallbacks';

function createFakeProtocolApp(
  overrides: Partial<DesktopProtocolApp> = {},
): DesktopProtocolApp & {
  listeners: {
    secondInstance?: (
      event: unknown,
      argv: string[],
      workingDirectory: string,
    ) => void;
    openUrl?: (event: { preventDefault(): void }, url: string) => void;
  };
} {
  const listeners: {
    secondInstance?: (
      event: unknown,
      argv: string[],
      workingDirectory: string,
    ) => void;
    openUrl?: (event: { preventDefault(): void }, url: string) => void;
  } = {};

  return {
    isPackaged: true,
    listeners,
    setAsDefaultProtocolClient: vi.fn(() => true),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: 'second-instance' | 'open-url', listener) => {
      if (event === 'second-instance') {
        listeners.secondInstance = listener as typeof listeners.secondInstance;
      } else {
        listeners.openUrl = listener as typeof listeners.openUrl;
      }
    }),
    ...overrides,
  };
}

describe('desktop protocol callbacks', () => {
  it('parses texra auth callback URLs into host-neutral callback parts', () => {
    expect(
      parseDesktopProtocolCallback(
        'texra://texra-ai.texra/auth-callback?state=abc#access_token=tok&refresh_token=ref',
      ),
    ).toEqual({
      rawUrl:
        'texra://texra-ai.texra/auth-callback?state=abc#access_token=tok&refresh_token=ref',
      path: '/auth-callback',
      query: 'state=abc',
      fragment: 'access_token=tok&refresh_token=ref',
    });
  });

  it('accepts compact texra://auth-callback URLs from argv handlers', () => {
    expect(parseDesktopProtocolCallback('texra://auth-callback')).toEqual({
      rawUrl: 'texra://auth-callback',
      path: '/auth-callback',
      query: '',
      fragment: '',
    });
  });

  it('accepts compact callback URLs with a trailing slash', () => {
    expect(parseDesktopProtocolCallback('texra://auth-callback/')).toEqual({
      rawUrl: 'texra://auth-callback/',
      path: '/auth-callback',
      query: '',
      fragment: '',
    });
  });

  it('accepts full callback URLs with a trailing slash', () => {
    expect(
      parseDesktopProtocolCallback(
        'texra://texra-ai.texra/auth-callback/?state=abc',
      ),
    ).toEqual({
      rawUrl: 'texra://texra-ai.texra/auth-callback/?state=abc',
      path: '/auth-callback',
      query: 'state=abc',
      fragment: '',
    });
  });

  it('accepts extension-auth-callback URLs for shared auth parsing', () => {
    expect(
      parseDesktopProtocolCallback(
        'texra://extension-auth-callback?access_token=query&refresh_token=refresh',
      ),
    ).toEqual(
      expect.objectContaining({
        path: '/extension-auth-callback',
        query: 'access_token=query&refresh_token=refresh',
      }),
    );
  });

  it('ignores malformed, non-texra, and unrelated protocol URLs', () => {
    expect(parseDesktopProtocolCallback('not a url')).toBeNull();
    expect(
      parseDesktopProtocolCallback('https://texra.ai/auth-callback'),
    ).toBeNull();
    expect(
      parseDesktopProtocolCallback('texra://texra-ai.texra/help'),
    ).toBeNull();
  });

  it('finds only TeXRA callback URLs in process argv', () => {
    expect(
      findDesktopProtocolUrls([
        '--flag',
        'texra://texra-ai.texra/auth-callback?code=1',
        'texra://texra-ai.texra/help',
      ]),
    ).toEqual(['texra://texra-ai.texra/auth-callback?code=1']);
  });

  it('queues startup callbacks until auth code subscribes', () => {
    const router = createDesktopProtocolCallbackRouter();
    router.routeUrl('texra://texra-ai.texra/auth-callback?state=startup');

    const listener = vi.fn();
    router.subscribe(listener);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        rawUrl: 'texra://texra-ai.texra/auth-callback?state=startup',
        path: '/auth-callback',
        query: 'state=startup',
      }),
    );
  });

  it('routes argv callbacks when routeArgv is passed as a standalone function', () => {
    const router = createDesktopProtocolCallbackRouter();
    const listener = vi.fn();
    router.subscribe(listener);

    const { routeArgv } = router;
    expect(
      routeArgv(['texra://texra-ai.texra/auth-callback?state=standalone']),
    ).toBe(1);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'state=standalone' }),
    );
  });

  it('registers protocol handling and routes warm-start argv callbacks', () => {
    const app = createFakeProtocolApp();
    const focusMainWindow = vi.fn();
    const lifecycle = installDesktopProtocolCallbackLifecycle({
      app,
      argv: [],
      focusMainWindow,
    });
    const listener = vi.fn();
    lifecycle.router.subscribe(listener);

    app.listeners.secondInstance?.(
      {},
      ['TeXRA.app', 'texra://texra-ai.texra/auth-callback?state=warm'],
      '/tmp',
    );

    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('texra');
    expect(app.requestSingleInstanceLock).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'state=warm' }),
    );
    expect(focusMainWindow).toHaveBeenCalled();
  });

  it('focuses the existing window on second-instance launches without callbacks', () => {
    const app = createFakeProtocolApp();
    const focusMainWindow = vi.fn();
    const lifecycle = installDesktopProtocolCallbackLifecycle({
      app,
      argv: [],
      focusMainWindow,
    });
    const listener = vi.fn();
    lifecycle.router.subscribe(listener);

    app.listeners.secondInstance?.({}, ['TeXRA.app'], '/tmp');

    expect(listener).not.toHaveBeenCalled();
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });

  it('routes macOS open-url callbacks and prevents default handling', () => {
    const app = createFakeProtocolApp();
    const focusMainWindow = vi.fn();
    const lifecycle = installDesktopProtocolCallbackLifecycle({
      app,
      argv: [],
      focusMainWindow,
    });
    const listener = vi.fn();
    const event = { preventDefault: vi.fn() };
    lifecycle.router.subscribe(listener);

    app.listeners.openUrl?.(
      event,
      'texra://texra-ai.texra/auth-callback#access_token=tok',
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ fragment: 'access_token=tok' }),
    );
    expect(focusMainWindow).toHaveBeenCalled();
  });

  it('focuses the existing window for unsupported texra open-url events', () => {
    const app = createFakeProtocolApp();
    const focusMainWindow = vi.fn();
    const lifecycle = installDesktopProtocolCallbackLifecycle({
      app,
      argv: [],
      focusMainWindow,
    });
    const listener = vi.fn();
    const event = { preventDefault: vi.fn() };
    lifecycle.router.subscribe(listener);

    app.listeners.openUrl?.(event, 'texra://texra-ai.texra/help');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });

  it('quits when another desktop instance owns the protocol lifecycle', () => {
    const app = createFakeProtocolApp({
      requestSingleInstanceLock: vi.fn(() => false),
    });

    const lifecycle = installDesktopProtocolCallbackLifecycle({
      app,
      argv: ['texra://texra-ai.texra/auth-callback'],
    });

    expect(lifecycle.shouldContinue).toBe(false);
    expect(app.quit).toHaveBeenCalled();
  });
});
