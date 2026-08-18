// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  invalidateRemoteAgentsAfterSignOut: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}));

// Test doubles installed through the module seams the provider's constructor
// already depends on, so tests build a real provider instead of fabricating
// one from its prototype and private fields.
const testDoubles = vi.hoisted(() => ({
  coordinator: null as Record<string, ReturnType<typeof vi.fn>> | null,
  emitters: [] as Array<{ fire: ReturnType<typeof vi.fn> }>,
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn();
    dispose = vi.fn();
    fire = vi.fn();
    constructor() {
      testDoubles.emitters.push(this);
    }
  },
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: {} }),
}));

vi.mock('@auth/SupabaseAuthCoordinator', () => ({
  createHostAuthCoordinator: () => testDoubles.coordinator,
}));

vi.mock('@auth/SupabaseClient', () => ({
  SupabaseClient: {
    getClient: () => ({
      auth: {
        getUser: providerMocks.getUser,
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
import type { SupabaseSession } from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import type { SupabaseUriHandler } from '@frontend/auth/UriHandler';

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
  showSignInPrompt: ReturnType<typeof vi.fn>;
} {
  const clearSessionIfCurrent = vi.fn(async () => true);
  const getStoredSessionState = vi.fn<() => Promise<StoredSessionState>>(
    async () => 'invalid',
  );
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
    showError: vi.fn(),
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

    await authCallback?.({ path: '/auth-callback', query: 'code=test' });

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
});
