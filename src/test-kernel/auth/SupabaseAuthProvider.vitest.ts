// Third-party imports
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  asExternalUri: vi.fn(async (uri: { toString: () => string }) => uri),
  getUser: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  invalidateRemoteAgentsAfterSignOut: vi.fn(async () => {}),
  openExternal: vi.fn(async () => true),
  runPkceOperation: vi.fn((operation: () => Promise<unknown>) => {
    const result = testDoubles.pkceTail.then(operation);
    testDoubles.pkceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }),
  secretDelete: vi.fn(async (key: string) => {
    testDoubles.secrets.delete(key);
  }),
  secretGetStored: vi.fn(async (key: string) => testDoubles.secrets.get(key)),
  secretListStoredKeys: vi.fn(async () => [...testDoubles.secrets.keys()]),
  signInWithOAuth: vi.fn(),
  signOut: vi.fn(async () => {}),
}));

// Test doubles installed through the module seams the provider's constructor
// already depends on, so tests build a real provider instead of fabricating
// one from its prototype and private fields.
const testDoubles = vi.hoisted(() => ({
  coordinator: null as Record<string, ReturnType<typeof vi.fn>> | null,
  emitters: [] as Array<{ fire: ReturnType<typeof vi.fn> }>,
  pkceTail: Promise.resolve<unknown>(undefined),
  secrets: new Map<string, string>(),
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    private readonly listeners = new Set<(value: unknown) => unknown>();
    readonly event = vi.fn((listener: (value: unknown) => unknown) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    });
    dispose = vi.fn(() => this.listeners.clear());
    fire = vi.fn((value: unknown) => {
      for (const listener of this.listeners) void listener(value);
    });
    constructor() {
      testDoubles.emitters.push(this);
    }
  },
  env: {
    uiKind: 1,
    uriScheme: 'vscode',
    openExternal: providerMocks.openExternal,
    // Web/Codespaces routing: the real API maps the vscode:// callback to a
    // tunnel URL carrying a ?state= token, which the provider must preserve.
    asExternalUri: providerMocks.asExternalUri,
  },
  ProgressLocation: { Notification: 15 },
  UIKind: { Desktop: 1, Web: 2 },
  Uri: {
    parse: (value: string) => ({ value, toString: () => value }),
  },
  window: {
    withProgress: vi.fn(async (_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
        },
      ),
    ),
  },
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    secrets: {
      get: async (key: string) => testDoubles.secrets.get(key),
      getStored: providerMocks.secretGetStored,
      set: async (key: string, value: string) => {
        testDoubles.secrets.set(key, value);
      },
      delete: providerMocks.secretDelete,
      listStoredKeys: providerMocks.secretListStoredKeys,
    },
  }),
}));

vi.mock('@auth/SupabaseAuthCoordinator', () => ({
  createHostAuthCoordinator: () => testDoubles.coordinator,
}));

vi.mock('@auth/SupabaseClient', () => ({
  SupabaseClient: {
    runPkceOperation: providerMocks.runPkceOperation,
    getClient: () => ({
      auth: {
        getUser: providerMocks.getUser,
        signInWithOAuth: providerMocks.signInWithOAuth,
        signOut: providerMocks.signOut,
      },
    }),
  },
}));

vi.mock('@agent/index', () => ({
  invalidateRemoteAgentsAfterSignOut:
    providerMocks.invalidateRemoteAgentsAfterSignOut,
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: providerMocks.invalidateModelOptionsCache,
}));

// Local imports
import { AUTH_CALLBACK_TIMEOUT_MS } from '@auth/config';
import type { SupabaseSession } from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import type { SupabaseUriHandler } from '@frontend/auth/UriHandler';

const PENDING_STATE_PREFIX = 'texra.extension.pendingOAuthState.';
const TEST_NONCE = '0123456789abcdef0123456789abcdef';
const TEST_FLOW_ID = 'abcdef0123456789abcdef0123456789';

function seedPendingOAuthAttempt(
  nonce = TEST_NONCE,
  createdAt = Date.now(),
  flowId = TEST_FLOW_ID,
): void {
  testDoubles.secrets.set(
    `${PENDING_STATE_PREFIX}${nonce}`,
    JSON.stringify({ nonce, createdAt, flowId }),
  );
}

afterEach(() => {
  testDoubles.secrets.clear();
  testDoubles.pkceTail = Promise.resolve(undefined);
  Object.assign(vscode.env, { uiKind: vscode.UIKind.Desktop });
});

function createProvider(options: {
  expiresAt: number;
  failure?: 'invalid' | 'transient';
}): {
  provider: SupabaseAuthProvider;
  session: SupabaseSession;
  coordinator: Record<string, ReturnType<typeof vi.fn>>;
  fire: ReturnType<typeof vi.fn>;
  clearSessionIfCurrent: ReturnType<typeof vi.fn>;
  getStoredSessionState: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  showSignInPrompt: ReturnType<typeof vi.fn>;
} {
  const clearSessionIfCurrent = vi.fn(async () => true);
  const getStoredSessionState = vi.fn<() => Promise<StoredSessionState>>(
    async () => 'invalid',
  );
  const showError = vi.fn();
  const showSignInPrompt = vi.fn();
  const session: SupabaseSession = {
    id: 'user-id',
    accessToken: 'expired-access',
    refreshToken: 'refresh-token',
    account: { id: 'user-id', label: 'user@example.com' },
    expiresAt: options.expiresAt,
  };
  const coordinator = {
    loadSession: vi.fn(async () => session),
    refreshSession: vi.fn(async () => null),
    storeSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    getStoredSessionState,
    getLastRefreshFailure: vi.fn(() => options.failure ?? null),
    clearSessionIfCurrent,
    createSessionFromCallback: vi.fn(),
  };
  testDoubles.coordinator = coordinator;
  testDoubles.emitters.length = 0;
  const provider = new SupabaseAuthProvider({
    showError,
    showInfo: vi.fn(),
    showSignInPrompt,
  });
  const emitter = testDoubles.emitters[0];
  if (!emitter) throw new Error('provider did not create a session emitter');

  return {
    provider,
    session,
    coordinator,
    fire: emitter.fire,
    clearSessionIfCurrent,
    getStoredSessionState,
    showError,
    showSignInPrompt,
  };
}

function createExpiredProvider(
  failure: 'invalid' | 'transient',
): ReturnType<typeof createProvider> {
  return createProvider({
    expiresAt: Date.now() - 1_000,
    failure,
  });
}

function createUnexpiredProvider(): ReturnType<typeof createProvider> {
  return createProvider({ expiresAt: Date.now() + 60_000 });
}

function createUriHandlerHarness(): {
  handler: SupabaseUriHandler;
  fire(uri: { path: string; query: string }): Promise<void>;
  listenerCount(): number;
} {
  const listeners = new Set<
    (uri: { path: string; query: string }) => void | Promise<void>
  >();
  return {
    handler: {
      onDidReceiveCallback: (
        listener: (uri: {
          path: string;
          query: string;
        }) => void | Promise<void>,
      ) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      handleUri: vi.fn(),
    } as unknown as SupabaseUriHandler,
    async fire(uri) {
      await Promise.all([...listeners].map((listener) => listener(uri)));
    },
    listenerCount: () => listeners.size,
  };
}

describe('SupabaseAuthProvider expired-session refresh', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('preserves a stored session after a transient refresh failure', async () => {
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createExpiredProvider('transient');

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).not.toHaveBeenCalled();
    expect(showSignInPrompt).not.toHaveBeenCalled();
  });

  it('clears a stored session after an invalid refresh credential', async () => {
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createExpiredProvider('invalid');

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).toHaveBeenCalledOnce();
    expect(showSignInPrompt).toHaveBeenCalledWith('expired');
    expect(providerMocks.signOut).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'when user validation is transient',
      userResponse: { data: { user: null }, error: { status: 503 } },
    },
    {
      name: 'after an inconclusive user response',
      userResponse: { data: { user: null }, error: null },
    },
  ])('preserves an unexpired session $name', async ({ userResponse }) => {
    providerMocks.getUser.mockResolvedValue(userResponse);
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createUnexpiredProvider();

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).not.toHaveBeenCalled();
    expect(showSignInPrompt).not.toHaveBeenCalled();
  });

  it('clears an unexpired session rejected during user validation', async () => {
    providerMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 401 },
    });
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createUnexpiredProvider();

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).toHaveBeenCalledOnce();
    expect(showSignInPrompt).toHaveBeenCalledWith('invalid');
  });

  it('does not prompt or clear caches when validation belongs to a replaced session', async () => {
    providerMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 401 },
    });
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createUnexpiredProvider();
    clearSessionIfCurrent.mockResolvedValueOnce(false);

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).toHaveBeenCalledOnce();
    expect(showSignInPrompt).not.toHaveBeenCalled();
    expect(providerMocks.signOut).not.toHaveBeenCalled();
  });

  it('does not clear a session that revalidates as authenticated', async () => {
    const { provider, clearSessionIfCurrent, getStoredSessionState } =
      createUnexpiredProvider();
    getStoredSessionState.mockResolvedValueOnce('authenticated');

    await expect(provider.clearStoredSession()).resolves.toBe(false);

    expect(clearSessionIfCurrent).not.toHaveBeenCalled();
  });
});

describe('SupabaseAuthProvider model availability', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Listeners recompute model options from the session-change event, so an
  // event published ahead of the invalidation serves the stale option list.
  it('invalidates model availability before publishing a new session', async () => {
    seedPendingOAuthAttempt();
    const { provider, session, coordinator, fire } = createUnexpiredProvider();

    // Drive the login path through its public seams: a late OAuth callback
    // delivered to the registered URI handler stores the session.
    coordinator.loadSession.mockResolvedValueOnce(null);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session,
    });
    let authCallback:
      ((uri: { path: string; query: string }) => unknown) | undefined;
    const handler = {
      onDidReceiveCallback: (
        listener: (uri: { path: string; query: string }) => unknown,
      ) => {
        authCallback = listener;
        return { dispose: vi.fn() };
      },
      handleUri: vi.fn(),
    } as unknown as SupabaseUriHandler;
    provider.setUriHandler(handler);

    await authCallback?.({
      path: '/auth-callback',
      query: `code=test&app_nonce=${TEST_NONCE}`,
    });

    expect(providerMocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(
      providerMocks.invalidateModelOptionsCache.mock.invocationCallOrder[0],
    ).toBeLessThan(fire.mock.invocationCallOrder[0]);
  });

  it('invalidates model availability before publishing a sign-out', async () => {
    const { provider, session, fire } = createUnexpiredProvider();

    await provider.removeSession(session.id);

    expect(providerMocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(
      providerMocks.invalidateModelOptionsCache.mock.invocationCallOrder[0],
    ).toBeLessThan(fire.mock.invocationCallOrder[0]);
  });

  // The shared client persists no session, so a remote sign-out would revoke
  // whichever session was last handed to it — at supabase-js's default global
  // scope, on every device. Sign-out clears local storage only, as on desktop
  // and the CLI.
  it('clears the stored session without a remote revocation', async () => {
    const { provider, session, coordinator } = createUnexpiredProvider();

    await provider.removeSession(session.id);

    expect(coordinator.clearSession).toHaveBeenCalledOnce();
    expect(providerMocks.signOut).not.toHaveBeenCalled();
  });

  it('clears its pending OAuth attempt when signing out without a session', async () => {
    const { provider, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.loadSession.mockResolvedValue(null);
    let redirectTo = '';
    providerMocks.signInWithOAuth.mockImplementation(async (input) => {
      redirectTo = input.options.redirectTo;
      return {
        data: {
          url: 'https://provider.example/authorize',
          flowId: TEST_FLOW_ID,
        },
        error: null,
      };
    });
    let browserOpened!: () => void;
    const browserLaunch = new Promise<void>((resolve) => {
      browserOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      browserOpened();
      return true;
    });
    const signIn = provider.createSession([]).catch(() => null);
    await browserLaunch;

    await expect(provider.removeStoredSession()).resolves.toBe(false);
    await signIn;

    const nonce = redirectTo.split('/').at(-1);
    expect(
      testDoubles.secrets.get(`${PENDING_STATE_PREFIX}${nonce}`),
    ).toBeUndefined();
  });
});

describe('SupabaseAuthProvider OAuth callback binding', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('persists and consumes a desktop nonce with the waiter armed before browser launch', async () => {
    const { provider, session, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session,
    });
    providerMocks.getUser.mockResolvedValue({
      data: { user: { id: session.id } },
      error: null,
    });

    let redirectTo = '';
    providerMocks.signInWithOAuth.mockImplementation(async (input) => {
      redirectTo = input.options.redirectTo;
      return {
        data: {
          url: 'https://provider.example/authorize',
          flowId: TEST_FLOW_ID,
        },
        error: null,
      };
    });
    providerMocks.openExternal.mockImplementation(async () => {
      const nonce = redirectTo.split('/').at(-1);
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(uriHandler.listenerCount()).toBe(2);
      expect(
        JSON.parse(
          testDoubles.secrets.get(`${PENDING_STATE_PREFIX}${nonce}`) ?? '',
        ),
      ).toEqual({
        nonce,
        createdAt: expect.any(Number),
        flowId: TEST_FLOW_ID,
      });
      await uriHandler.fire({
        path: '/auth-callback',
        query: `code=one-time-code&app_nonce=${nonce}`,
      });
      return true;
    });

    await expect(provider.createSession([])).resolves.toMatchObject({
      id: session.id,
    });

    expect(redirectTo).toMatch(
      /\/auth-bridge\/vscode\/texra-ai\.texra\/[0-9a-f]{32}$/,
    );
    expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    const nonce = redirectTo.split('/').at(-1);
    expect(
      testDoubles.secrets.get(`${PENDING_STATE_PREFIX}${nonce}`),
    ).toBeUndefined();
  });

  it('preserves web routing state bytes while carrying the application nonce separately', async () => {
    Object.assign(vscode.env, { uiKind: vscode.UIKind.Web });
    const callbackUrl =
      'https://example.github.dev/extension-auth-callback?state=a%2Bb%2F%3D';
    providerMocks.asExternalUri.mockResolvedValue({
      toString: () => callbackUrl,
    });
    const { provider, session, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session,
    });
    providerMocks.getUser.mockResolvedValue({
      data: { user: { id: session.id } },
      error: null,
    });

    let redirectTo = '';
    providerMocks.signInWithOAuth.mockImplementation(async (input) => {
      redirectTo = input.options.redirectTo;
      return {
        data: {
          url: 'https://provider.example/authorize',
          flowId: TEST_FLOW_ID,
        },
        error: null,
      };
    });
    providerMocks.openExternal.mockImplementation(async () => {
      const nonce = new URL(redirectTo).searchParams.get('app_nonce');
      await uriHandler.fire({
        path: '/extension-auth-callback',
        query: `code=one-time-code&app_nonce=${nonce}`,
      });
      return true;
    });

    await provider.createSession([]);

    expect(redirectTo).toMatch(
      new RegExp(
        `^${callbackUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}&app_nonce=[0-9a-f]{32}$`,
      ),
    );
  });

  it('allows another live extension window to claim an attempt started by the first', async () => {
    const first = createUnexpiredProvider();
    const second = createUnexpiredProvider();
    const firstHandler = createUriHandlerHarness();
    const secondHandler = createUriHandlerHarness();
    first.provider.setUriHandler(firstHandler.handler);
    second.provider.setUriHandler(secondHandler.handler);
    second.coordinator.loadSession.mockResolvedValue(null);
    second.coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session: second.session,
    });

    const redirects: string[] = [];
    providerMocks.signInWithOAuth.mockImplementation(async (input) => {
      redirects.push(input.options.redirectTo);
      return {
        data: {
          url: 'https://provider.example/authorize',
          flowId:
            redirects.length === 1
              ? TEST_FLOW_ID
              : '1234567890abcdef1234567890abcdef',
        },
        error: null,
      };
    });
    let firstBrowserOpened!: () => void;
    const firstBrowserLaunch = new Promise<void>((resolve) => {
      firstBrowserOpened = resolve;
    });
    let secondBrowserOpened!: () => void;
    const secondBrowserLaunch = new Promise<void>((resolve) => {
      secondBrowserOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      if (redirects.length === 1) firstBrowserOpened();
      else secondBrowserOpened();
      return true;
    });

    const firstSignIn = first.provider.createSession([]).catch(() => null);
    await firstBrowserLaunch;
    const firstNonce = redirects[0].split('/').at(-1);
    await secondHandler.fire({
      path: '/auth-callback',
      query: `code=second-window&app_nonce=${firstNonce}`,
    });
    expect(second.coordinator.createSessionFromCallback).toHaveBeenCalledOnce();

    const secondSignIn = second.provider.createSession([]).catch(() => null);
    await secondBrowserLaunch;
    const secondNonce = redirects[1].split('/').at(-1);
    first.provider.dispose();
    await firstSignIn;

    expect(
      testDoubles.secrets.get(`${PENDING_STATE_PREFIX}${secondNonce}`),
    ).toBeDefined();
    second.provider.dispose();
    await secondSignIn;
  });

  it('waits for a claimed callback exchange before initializing the next PKCE flow', async () => {
    seedPendingOAuthAttempt();
    const first = createUnexpiredProvider();
    const firstHandler = createUriHandlerHarness();
    first.provider.setUriHandler(firstHandler.handler);
    first.coordinator.loadSession.mockResolvedValue(null);

    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    let finishExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    first.coordinator.createSessionFromCallback.mockImplementation(async () => {
      exchangeStarted();
      await exchangeGate;
      throw new Error('first exchange failed');
    });

    const firstCallback = firstHandler.fire({
      path: '/auth-callback',
      query: `code=first&app_nonce=${TEST_NONCE}`,
    });
    await started;

    const second = createUnexpiredProvider();
    const secondHandler = createUriHandlerHarness();
    second.provider.setUriHandler(secondHandler.handler);
    second.coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session: second.session,
    });
    providerMocks.getUser.mockResolvedValue({
      data: { user: { id: second.session.id } },
      error: null,
    });
    const secondFlowId = '1234567890abcdef1234567890abcdef';
    let redirectTo = '';
    providerMocks.signInWithOAuth.mockImplementation(async (input) => {
      redirectTo = input.options.redirectTo;
      return {
        data: {
          url: 'https://provider.example/authorize',
          flowId: secondFlowId,
        },
        error: null,
      };
    });
    let browserOpened!: () => void;
    const browserLaunch = new Promise<void>((resolve) => {
      browserOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      browserOpened();
      return true;
    });

    const secondSignIn = second.provider.createSession([]);
    await vi.waitFor(() =>
      expect(providerMocks.runPkceOperation).toHaveBeenCalledTimes(2),
    );
    expect(providerMocks.signInWithOAuth).not.toHaveBeenCalled();

    finishExchange();
    await firstCallback;
    await browserLaunch;
    expect(providerMocks.signInWithOAuth).toHaveBeenCalledOnce();

    const secondNonce = redirectTo.split('/').at(-1);
    await secondHandler.fire({
      path: '/auth-callback',
      query: `code=second&app_nonce=${secondNonce}`,
    });
    await expect(secondSignIn).resolves.toMatchObject({
      id: second.session.id,
    });
    expect(second.coordinator.createSessionFromCallback).toHaveBeenCalledWith(
      {
        path: '/auth-callback',
        query: expect.stringContaining('code=second'),
      },
      secondFlowId,
    );
  });

  it('prevents a superseded callback from committing or clearing the newer attempt', async () => {
    const { provider, session, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session,
    });
    providerMocks.getUser.mockResolvedValue({
      data: { user: { id: session.id } },
      error: null,
    });

    const redirects: string[] = [];
    providerMocks.signInWithOAuth.mockImplementation(async (input) => {
      redirects.push(input.options.redirectTo);
      return {
        data: {
          url: 'https://provider.example/authorize',
          flowId: TEST_FLOW_ID,
        },
        error: null,
      };
    });
    let firstOpened!: () => void;
    const firstBrowserLaunch = new Promise<void>((resolve) => {
      firstOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      if (redirects.length === 1) {
        firstOpened();
        return true;
      }
      const oldNonce = redirects[0].split('/').at(-1);
      const newNonce = redirects[1].split('/').at(-1);
      await uriHandler.fire({
        path: '/auth-callback',
        query: `code=old&app_nonce=${oldNonce}`,
      });
      await uriHandler.fire({
        path: '/auth-callback',
        query: `code=new&app_nonce=${newNonce}`,
      });
      return true;
    });

    const first = provider.createSession([]).catch(() => null);
    await firstBrowserLaunch;
    const second = provider.createSession([]);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toMatchObject({ id: session.id });
    expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    expect(coordinator.createSessionFromCallback).toHaveBeenCalledWith(
      {
        path: '/auth-callback',
        query: expect.stringContaining('code=new'),
      },
      TEST_FLOW_ID,
    );
  });

  it('accepts another window callback while its own attempt remains live', async () => {
    const ownFlowId = '1234567890abcdef1234567890abcdef';
    seedPendingOAuthAttempt();
    const { provider, session, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.loadSession.mockResolvedValue(null);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session,
    });
    providerMocks.signInWithOAuth.mockResolvedValue({
      data: {
        url: 'https://provider.example/authorize',
        flowId: ownFlowId,
      },
      error: null,
    });
    let browserOpened!: () => void;
    const browserLaunch = new Promise<void>((resolve) => {
      browserOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      browserOpened();
      return true;
    });

    const ownSignIn = provider.createSession([]).catch(() => null);
    await browserLaunch;
    await uriHandler.fire({
      path: '/auth-callback',
      query: `code=other-window&app_nonce=${TEST_NONCE}`,
    });
    await uriHandler.fire({
      path: '/auth-callback',
      query: `code=replay&app_nonce=${TEST_NONCE}`,
    });

    expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    expect(coordinator.createSessionFromCallback).toHaveBeenCalledWith(
      {
        path: '/auth-callback',
        query: expect.stringContaining('code=other-window'),
      },
      TEST_FLOW_ID,
    );
    provider.dispose();
    await ownSignIn;
  });

  it.each(['read', 'delete'] as const)(
    'contains a secret-store %s claim failure and accepts a later callback',
    async (operation) => {
      const secondNonce = 'ffffffffffffffffffffffffffffffff';
      seedPendingOAuthAttempt();
      seedPendingOAuthAttempt(secondNonce);
      const { provider, session, coordinator, showError } =
        createUnexpiredProvider();
      const uriHandler = createUriHandlerHarness();
      provider.setUriHandler(uriHandler.handler);
      coordinator.loadSession.mockResolvedValue(null);
      coordinator.createSessionFromCallback.mockResolvedValue({
        success: true,
        session,
      });
      const failure = new Error('secret backend unavailable: private detail');
      if (operation === 'read') {
        providerMocks.secretGetStored.mockRejectedValueOnce(failure);
      } else {
        providerMocks.secretDelete.mockRejectedValueOnce(failure);
      }

      await expect(
        uriHandler.fire({
          path: '/auth-callback',
          query: `code=first&app_nonce=${TEST_NONCE}`,
        }),
      ).resolves.toBeUndefined();
      await uriHandler.fire({
        path: '/auth-callback',
        query: `code=second&app_nonce=${secondNonce}`,
      });

      expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
      expect(showError).toHaveBeenCalledWith(
        'Sign-in failed: OAuth callback state could not be verified. Try again.',
      );
    },
  );

  it('sweeps malformed, expired, and flowless pending OAuth records', async () => {
    const expiredNonce = '11111111111111111111111111111111';
    const flowlessNonce = '22222222222222222222222222222222';
    const malformedNonce = '33333333333333333333333333333333';
    const validNonce = '44444444444444444444444444444444';
    seedPendingOAuthAttempt(
      expiredNonce,
      Date.now() - AUTH_CALLBACK_TIMEOUT_MS - 1,
    );
    testDoubles.secrets.set(
      `${PENDING_STATE_PREFIX}${flowlessNonce}`,
      JSON.stringify({ nonce: flowlessNonce, createdAt: Date.now() }),
    );
    testDoubles.secrets.set(`${PENDING_STATE_PREFIX}${malformedNonce}`, '{');
    seedPendingOAuthAttempt(validNonce);
    testDoubles.secrets.set('unrelated', 'keep');
    const { provider } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    providerMocks.signInWithOAuth.mockResolvedValue({
      data: {
        url: 'https://provider.example/authorize',
        flowId: TEST_FLOW_ID,
      },
      error: null,
    });
    let browserOpened!: () => void;
    const browserLaunch = new Promise<void>((resolve) => {
      browserOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      browserOpened();
      return true;
    });

    const signIn = provider.createSession([]).catch(() => null);
    await browserLaunch;

    expect(
      testDoubles.secrets.has(`${PENDING_STATE_PREFIX}${expiredNonce}`),
    ).toBe(false);
    expect(
      testDoubles.secrets.has(`${PENDING_STATE_PREFIX}${flowlessNonce}`),
    ).toBe(false);
    expect(
      testDoubles.secrets.has(`${PENDING_STATE_PREFIX}${malformedNonce}`),
    ).toBe(false);
    expect(
      testDoubles.secrets.has(`${PENDING_STATE_PREFIX}${validNonce}`),
    ).toBe(true);
    expect(testDoubles.secrets.get('unrelated')).toBe('keep');
    provider.dispose();
    await signIn;
  });

  it('handles callback rejection while browser launch is still pending', async () => {
    const { provider, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: false,
      error: 'exchange failed',
      isAuthError: true,
    });
    providerMocks.signInWithOAuth.mockResolvedValue({
      data: {
        url: 'https://provider.example/authorize',
        flowId: TEST_FLOW_ID,
      },
      error: null,
    });
    let releaseBrowser!: () => void;
    let browserOpened!: () => void;
    const browserLaunch = new Promise<void>((resolve) => {
      browserOpened = resolve;
    });
    providerMocks.openExternal.mockImplementation(async () => {
      browserOpened();
      await new Promise<void>((resolve) => {
        releaseBrowser = resolve;
      });
      return true;
    });

    const signIn = provider.createSession([]);
    await browserLaunch;
    const redirectTo = providerMocks.signInWithOAuth.mock.calls[0][0].options
      .redirectTo as string;
    const nonce = redirectTo.split('/').at(-1);
    await uriHandler.fire({
      path: '/auth-callback',
      query: `code=test&app_nonce=${nonce}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBrowser();

    await expect(signIn).rejects.toThrow('OAuth error: exchange failed');
  });

  it('rejects missing, duplicate, malformed, mismatched, expired, and replayed callbacks', async () => {
    seedPendingOAuthAttempt();
    const { provider, session, coordinator } = createUnexpiredProvider();
    const uriHandler = createUriHandlerHarness();
    provider.setUriHandler(uriHandler.handler);
    coordinator.loadSession.mockResolvedValue(null);
    coordinator.createSessionFromCallback.mockResolvedValue({
      success: true,
      session,
    });

    for (const query of [
      'code=test',
      `code=test&app_nonce=${TEST_NONCE}&app_nonce=${TEST_NONCE}`,
      'code=test&app_nonce=not-a-nonce',
      'code=test&app_nonce=ffffffffffffffffffffffffffffffff',
    ]) {
      await uriHandler.fire({ path: '/auth-callback', query });
    }
    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();

    await uriHandler.fire({
      path: '/auth-callback',
      query: `code=test&app_nonce=${TEST_NONCE}`,
    });
    await uriHandler.fire({
      path: '/auth-callback',
      query: `code=test&app_nonce=${TEST_NONCE}`,
    });
    expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();

    seedPendingOAuthAttempt(TEST_NONCE, Date.now() - 10 * 60 * 1000 - 1);
    const expired = createUnexpiredProvider();
    const expiredHandler = createUriHandlerHarness();
    expired.provider.setUriHandler(expiredHandler.handler);
    await expiredHandler.fire({
      path: '/auth-callback',
      query: `code=test&app_nonce=${TEST_NONCE}`,
    });
    expect(
      expired.coordinator.createSessionFromCallback,
    ).not.toHaveBeenCalled();
  });
});
