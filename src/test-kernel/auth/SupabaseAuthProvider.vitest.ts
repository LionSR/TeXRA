// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  clearAllCaches: vi.fn(),
  getUser: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  invalidateRemoteAgentsAfterSignOut: vi.fn(async () => {}),
  setTokenExpiry: vi.fn(),
  signOut: vi.fn(async () => {}),
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn();
    dispose = vi.fn();
    fire = vi.fn();
  },
}));

vi.mock('@auth/SupabaseClient', () => ({
  SupabaseClient: {
    getClient: () => ({
      auth: {
        getUser: providerMocks.getUser,
        signOut: providerMocks.signOut,
      },
    }),
    setTokenExpiry: providerMocks.setTokenExpiry,
  },
}));

vi.mock('@agent/index', () => ({
  invalidateRemoteAgentsAfterSignOut:
    providerMocks.invalidateRemoteAgentsAfterSignOut,
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    clearAllCaches: providerMocks.clearAllCaches,
  }),
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: providerMocks.invalidateModelOptionsCache,
}));

// Local imports
import type {
  SupabaseSession,
  SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';

function createProvider(options: {
  expiresAt: number;
  failure?: 'invalid' | 'transient';
}): {
  provider: SupabaseAuthProvider;
  session: SupabaseSession;
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
  const fire = vi.fn();
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
  };
  const provider = Object.create(
    SupabaseAuthProvider.prototype,
  ) as SupabaseAuthProvider;
  Object.assign(provider, {
    _onDidChangeSessions: { fire },
    sessionCoordinator: coordinator as unknown as SupabaseSessionCoordinator,
    notifier: {
      showError: vi.fn(),
      showInfo: vi.fn(),
      showSignInPrompt,
    },
  });

  return {
    provider,
    session,
    fire,
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

  it('preserves an unexpired session when user validation is transient', async () => {
    providerMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 503 },
    });
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createProvider({
        expiresAt: Date.now() + 60_000,
      });

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).not.toHaveBeenCalled();
    expect(showSignInPrompt).not.toHaveBeenCalled();
  });

  it('preserves an unexpired session after an inconclusive user response', async () => {
    providerMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });
    const { provider, clearSessionIfCurrent, showSignInPrompt } =
      createProvider({
        expiresAt: Date.now() + 60_000,
      });

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
      createProvider({
        expiresAt: Date.now() + 60_000,
      });

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
      createProvider({
        expiresAt: Date.now() + 60_000,
      });
    clearSessionIfCurrent.mockResolvedValueOnce(false);

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSessionIfCurrent).toHaveBeenCalledOnce();
    expect(showSignInPrompt).not.toHaveBeenCalled();
    expect(providerMocks.clearAllCaches).not.toHaveBeenCalled();
    expect(providerMocks.signOut).not.toHaveBeenCalled();
  });

  it('does not clear a session that revalidates as authenticated', async () => {
    const { provider, clearSessionIfCurrent, getStoredSessionState } =
      createProvider({
        expiresAt: Date.now() + 60_000,
      });
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
    const { provider, session, fire } = createProvider({
      expiresAt: Date.now() + 60_000,
    });

    // The login path stores through a private method; no public entry point
    // reaches it without a live OAuth round trip.
    await (
      provider as unknown as {
        storeSession(session: SupabaseSession): Promise<void>;
      }
    ).storeSession(session);

    expect(providerMocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(
      providerMocks.invalidateModelOptionsCache.mock.invocationCallOrder[0],
    ).toBeLessThan(fire.mock.invocationCallOrder[0]);
  });

  it('invalidates model availability before publishing a sign-out', async () => {
    const { provider, session, fire } = createProvider({
      expiresAt: Date.now() + 60_000,
    });

    await provider.removeSession(session.id);

    expect(providerMocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(
      providerMocks.invalidateModelOptionsCache.mock.invocationCallOrder[0],
    ).toBeLessThan(fire.mock.invocationCallOrder[0]);
  });
});
