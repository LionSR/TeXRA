// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  clearAllCaches: vi.fn(),
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
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';

function createExpiredProvider(failure: 'invalid' | 'transient'): {
  provider: SupabaseAuthProvider;
  clearSession: ReturnType<typeof vi.fn>;
  showSignInPrompt: ReturnType<typeof vi.fn>;
} {
  const clearSession = vi.fn();
  const showSignInPrompt = vi.fn();
  const session = {
    id: 'user-id',
    accessToken: 'expired-access',
    refreshToken: 'refresh-token',
    account: { id: 'user-id', label: 'user@example.com' },
    expiresAt: Date.now() - 1_000,
  };
  const coordinator = {
    loadSession: vi.fn(async () => session),
    refreshSession: vi.fn(async () => null),
    getLastRefreshFailure: vi.fn(() => failure),
    clearSession,
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

  return { provider, clearSession, showSignInPrompt };
}

describe('SupabaseAuthProvider expired-session refresh', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('preserves a stored session after a transient refresh failure', async () => {
    const { provider, clearSession, showSignInPrompt } =
      createExpiredProvider('transient');

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSession).not.toHaveBeenCalled();
    expect(showSignInPrompt).not.toHaveBeenCalled();
  });

  it('clears a stored session after an invalid refresh credential', async () => {
    const { provider, clearSession, showSignInPrompt } =
      createExpiredProvider('invalid');

    await expect(provider.getSessions()).resolves.toEqual([]);

    expect(clearSession).toHaveBeenCalledOnce();
    expect(showSignInPrompt).toHaveBeenCalledWith('expired');
  });
});
