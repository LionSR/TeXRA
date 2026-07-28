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
import type { SupabaseSessionCoordinator } from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';

function createProvider(options: {
  expiresAt: number;
  failure?: 'invalid' | 'transient';
}): {
  provider: SupabaseAuthProvider;
  clearSessionIfCurrent: ReturnType<typeof vi.fn>;
  getStoredSessionState: ReturnType<typeof vi.fn>;
  showSignInPrompt: ReturnType<typeof vi.fn>;
} {
  const clearSessionIfCurrent = vi.fn(async () => true);
  const getStoredSessionState = vi.fn<() => Promise<StoredSessionState>>(
    async () => 'invalid',
  );
  const showSignInPrompt = vi.fn();
  const session = {
    id: 'user-id',
    accessToken: 'expired-access',
    refreshToken: 'refresh-token',
    account: { id: 'user-id', label: 'user@example.com' },
    expiresAt: options.expiresAt,
  };
  const coordinator = {
    loadSession: vi.fn(async () => session),
    refreshSession: vi.fn(async () => null),
    getStoredSessionState,
    getLastRefreshFailure: vi.fn(() => options.failure ?? null),
    clearSessionIfCurrent,
  };
  const provider = Object.create(
    SupabaseAuthProvider.prototype,
  ) as SupabaseAuthProvider;
  Object.assign(provider, {
    _onDidChangeSessions: {
      fire: vi.fn(),
    },
    sessionCoordinator: coordinator as unknown as SupabaseSessionCoordinator,
    notifier: {
      showError: vi.fn(),
      showInfo: vi.fn(),
      showSignInPrompt,
    },
  });

  return {
    provider,
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
