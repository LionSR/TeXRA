import { type Mock, describe, expect, it, vi } from 'vitest';
import {
  createDesktopProtocolCallbackRouter,
  type DesktopProtocolApp,
  findDesktopProtocolUrls,
  installDesktopProtocolCallbackLifecycle,
  parseDesktopProtocolCallback,
} from '@desktop/main/desktopProtocolCallbacks';

interface ProtocolListeners {
  secondInstance?: (
    event: unknown,
    argv: string[],
    workingDirectory: string,
  ) => void;
  openUrl?: (event: { preventDefault(): void }, url: string) => void;
}

type FakeProtocolApp = DesktopProtocolApp & {
  listeners: ProtocolListeners;
  setAsDefaultProtocolClient: Mock<(protocol: string) => boolean>;
  requestSingleInstanceLock: Mock<() => boolean>;
  quit: Mock<() => void>;
};

function createFakeProtocolApp(lockAvailable = true): FakeProtocolApp {
  const listeners: ProtocolListeners = {};

  return {
    isPackaged: true,
    listeners,
    setAsDefaultProtocolClient: vi.fn((_protocol: string) => true),
    requestSingleInstanceLock: vi.fn(() => lockAvailable),
    quit: vi.fn(),
    on: vi.fn((event: 'second-instance' | 'open-url', listener) => {
      if (event === 'second-instance') {
        listeners.secondInstance = listener as typeof listeners.secondInstance;
      } else {
        listeners.openUrl = listener as typeof listeners.openUrl;
      }
    }),
  };
}

function installLifecycle(argv: string[] = []) {
  const app = createFakeProtocolApp();
  const focusMainWindow = vi.fn();
  const lifecycle = installDesktopProtocolCallbackLifecycle({
    app,
    argv,
    focusMainWindow,
  });
  const listener = vi.fn();
  lifecycle.router.subscribe(listener);
  return { app, focusMainWindow, lifecycle, listener };
}

describe('desktop protocol callbacks', () => {
  it.each([
    {
      name: 'parses texra auth callback URLs into host-neutral callback parts',
      url: 'texra://texra-ai.texra/auth-callback?state=abc&code=authorization-code',
      path: '/auth-callback',
      query: 'state=abc&code=authorization-code',
    },
    {
      name: 'accepts compact texra://auth-callback URLs from argv handlers',
      url: 'texra://auth-callback',
      path: '/auth-callback',
      query: '',
    },
    {
      name: 'accepts compact callback URLs with a trailing slash',
      url: 'texra://auth-callback/',
      path: '/auth-callback',
      query: '',
    },
    {
      name: 'accepts full callback URLs with a trailing slash',
      url: 'texra://texra-ai.texra/auth-callback/?state=abc',
      path: '/auth-callback',
      query: 'state=abc',
    },
  ])('$name', ({ url, path, query }) => {
    expect(parseDesktopProtocolCallback(url)).toEqual({
      rawUrl: url,
      path,
      query,
    });
  });

  it('accepts extension-auth-callback URLs for shared auth parsing', () => {
    expect(
      parseDesktopProtocolCallback(
        'texra://extension-auth-callback?code=authorization-code',
      ),
    ).toEqual(
      expect.objectContaining({
        path: '/extension-auth-callback',
        query: 'code=authorization-code',
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
    const { app, focusMainWindow, listener } = installLifecycle();

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
    const { app, focusMainWindow, listener } = installLifecycle();

    app.listeners.secondInstance?.({}, ['TeXRA.app'], '/tmp');

    expect(listener).not.toHaveBeenCalled();
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });

  it('routes macOS open-url callbacks and prevents default handling', () => {
    const { app, focusMainWindow, listener } = installLifecycle();
    const event = { preventDefault: vi.fn() };

    app.listeners.openUrl?.(
      event,
      'texra://texra-ai.texra/auth-callback?code=authorization-code',
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'code=authorization-code' }),
    );
    expect(focusMainWindow).toHaveBeenCalled();
  });

  it('focuses the existing window for unsupported texra open-url events', () => {
    const { app, focusMainWindow, listener } = installLifecycle();
    const event = { preventDefault: vi.fn() };

    app.listeners.openUrl?.(event, 'texra://texra-ai.texra/help');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });
});

describe('desktop protocol callback lifecycle', () => {
  it.each([
    {
      name: 'stops a launch when another desktop instance owns the lock',
      lockAvailable: false,
      argv: [] as string[],
      shouldContinue: false,
      requestCount: 1,
      quitCount: 1,
      protocolRegistrations: [] as string[],
    },
    {
      name: 'allows the first desktop process to become primary',
      lockAvailable: true,
      argv: ['--texra-workspace-path=/Users/ray/paper'],
      shouldContinue: true,
      requestCount: 1,
      quitCount: 0,
      protocolRegistrations: ['texra'],
    },
  ])(
    '$name',
    ({
      lockAvailable,
      argv,
      shouldContinue,
      requestCount,
      quitCount,
      protocolRegistrations,
    }) => {
      const app = createFakeProtocolApp(lockAvailable);

      const lifecycle = installDesktopProtocolCallbackLifecycle({ app, argv });

      expect(lifecycle.shouldContinue).toBe(shouldContinue);
      expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(requestCount);
      expect(app.quit).toHaveBeenCalledTimes(quitCount);
      expect(
        app.setAsDefaultProtocolClient.mock.calls.map(([protocol]) => protocol),
      ).toEqual(protocolRegistrations);
    },
  );

  it('focuses the primary window for every second-instance launch', () => {
    const { app, focusMainWindow } = installLifecycle();

    app.listeners.secondInstance?.(
      {},
      ['--texra-workspace-path=/Users/ray/paper'],
      process.cwd(),
    );
    expect(focusMainWindow).toHaveBeenCalledTimes(1);

    app.listeners.secondInstance?.(
      {},
      ['--texra-workspace-path=/Users/ray/other-paper'],
      process.cwd(),
    );
    expect(focusMainWindow).toHaveBeenCalledTimes(2);
  });
});
