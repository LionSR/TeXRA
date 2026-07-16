// Suites for packages/desktop protocol callbacks (registration lifecycle +
// callback behavior).

import { strict as assert } from 'node:assert';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopProtocolCallbackRouter,
  type DesktopProtocolApp,
  findDesktopProtocolUrls,
  installDesktopProtocolCallbackLifecycle,
  parseDesktopProtocolCallback,
} from '@desktop/main/desktopProtocolCallbacks';

// ---------------------------------------------------------------------------
// DesktopProtocolCallbacks
// ---------------------------------------------------------------------------

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
      'texra://texra-ai.texra/auth-callback#access_token=tok',
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ fragment: 'access_token=tok' }),
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

// ---------------------------------------------------------------------------
// desktopProtocolCallbacks
// ---------------------------------------------------------------------------

type SecondInstanceListener = (
  event: unknown,
  argv: string[],
  workingDirectory: string,
  additionalData?: unknown,
) => void;

type OpenUrlListener = (event: { preventDefault(): void }, url: string) => void;

class FakeDesktopProtocolApp implements DesktopProtocolApp {
  readonly isPackaged = true;
  requestCount = 0;
  quitCount = 0;
  protocolRegistrations: string[] = [];
  private readonly secondInstanceListeners: SecondInstanceListener[] = [];
  private readonly lockAvailable: boolean;

  constructor(options: { lockAvailable: boolean }) {
    this.lockAvailable = options.lockAvailable;
  }

  setAsDefaultProtocolClient(protocol: string): boolean {
    this.protocolRegistrations.push(protocol);
    return true;
  }

  requestSingleInstanceLock(): boolean {
    this.requestCount += 1;
    return this.lockAvailable;
  }

  quit(): void {
    this.quitCount += 1;
  }

  on(event: 'second-instance', listener: SecondInstanceListener): void;
  on(event: 'open-url', listener: OpenUrlListener): void;
  on(
    event: 'second-instance' | 'open-url',
    listener: SecondInstanceListener | OpenUrlListener,
  ): void {
    if (event === 'second-instance') {
      this.secondInstanceListeners.push(listener as SecondInstanceListener);
      return;
    }
  }

  emitSecondInstance(argv: string[]): void {
    for (const listener of this.secondInstanceListeners) {
      listener({}, argv, process.cwd());
    }
  }
}

describe('desktop protocol callback lifecycle', () => {
  it.each([
    {
      name: 'keeps normal launches behind the single-instance lock',
      lockAvailable: false,
      argv: [] as string[],
      shouldContinue: false,
      requestCount: 1,
      quitCount: 1,
      protocolRegistrations: [] as string[],
    },
    {
      name: 'lets explicit new-window launches run as separate processes',
      lockAvailable: false,
      argv: ['--texra-new-window', '--texra-workspace-path=/Users/ray/paper'],
      shouldContinue: true,
      requestCount: 1,
      quitCount: 0,
      protocolRegistrations: [] as string[],
    },
    {
      name: 'lets explicit new-window launches become primary when no owner exists',
      lockAvailable: true,
      argv: ['--texra-new-window', '--texra-workspace-path=/Users/ray/paper'],
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
      const app = new FakeDesktopProtocolApp({ lockAvailable });

      const lifecycle = installDesktopProtocolCallbackLifecycle({ app, argv });

      assert.equal(lifecycle.shouldContinue, shouldContinue);
      assert.equal(app.requestCount, requestCount);
      assert.equal(app.quitCount, quitCount);
      assert.deepEqual(app.protocolRegistrations, protocolRegistrations);
    },
  );

  it('does not focus the primary window for explicit new-window probes', () => {
    const app = new FakeDesktopProtocolApp({ lockAvailable: true });
    let focusCount = 0;

    installDesktopProtocolCallbackLifecycle({
      app,
      argv: [],
      focusMainWindow: () => {
        focusCount += 1;
      },
    });

    app.emitSecondInstance([
      '--texra-new-window',
      '--texra-workspace-path=/Users/ray/paper',
    ]);
    assert.equal(focusCount, 0);

    app.emitSecondInstance(['--texra-workspace-path=/Users/ray/other-paper']);
    assert.equal(focusCount, 1);
  });
});
