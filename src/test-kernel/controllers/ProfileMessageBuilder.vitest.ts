import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent/index', () => ({
  getAgentsBySource: vi.fn(() => []),
  loadAgents: vi.fn(async () => {}),
  toRemoteAgentProfileData: vi.fn(),
}));

vi.mock('@utils/config/providerConfig', () => ({
  getGlobalStreaming: () => true,
}));

const serverSideKeyService = {
  getUseIncludedModelAccess: vi.fn(() => false),
  canUseServerSideKeys: vi.fn(async () => false),
  refreshSpendingStatus: vi.fn(async () => {}),
  getAccessExpirationDate: vi.fn(() => null),
  wasQuotaAutoSwitched: vi.fn(() => false),
  getSpendingStatus: vi.fn(() => null as unknown),
  getSpendingStatusError: vi.fn(() => null as unknown),
};

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => serverSideKeyService,
}));

import { SupabaseClient } from '@auth/SupabaseClient';
import { buildProfileMessage } from '@controllers/settingsView/ProfileMessageBuilder';

type StoredSessionState = Awaited<
  ReturnType<typeof SupabaseClient.getStoredSessionState>
>;

function stubStoredSession(
  sessionState: StoredSessionState,
  hasUsableRelayToken: boolean,
): void {
  vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
    sessionState,
  );
  vi.spyOn(SupabaseClient, 'hasUsableRelayToken').mockReturnValue(
    hasUsableRelayToken,
  );
  vi.spyOn(SupabaseClient, 'getStoredAccountLabel').mockResolvedValue(
    'researcher@example.com',
  );
}

function stubAuthenticatedRelayUser(
  tier: Awaited<ReturnType<typeof SupabaseClient.getUserTier>>,
): void {
  stubStoredSession('authenticated', true);
  vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue(null);
  vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue(tier);
}

describe('ProfileMessageBuilder session problems', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks an authoritatively rejected stored session as expired', async () => {
    stubStoredSession('invalid', false);
    const isAuthenticated = vi.spyOn(SupabaseClient, 'isAuthenticated');

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(message).toMatchObject({
      authenticated: false,
      sessionProblem: 'expired',
      user: { email: 'researcher@example.com' },
    });
    expect(SupabaseClient.getStoredSessionState).toHaveBeenCalledOnce();
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  it('preserves a stored session during a transient refresh outage', async () => {
    stubStoredSession('transient', false);

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(message).toMatchObject({
      authenticated: false,
      sessionProblem: 'unavailable',
      user: { email: 'researcher@example.com' },
    });
  });

  it('does not let relay authentication mask an invalid stored session', async () => {
    stubStoredSession('invalid', true);
    vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue(null);
    vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue('free');

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(message).toMatchObject({
      authenticated: true,
      sessionProblem: 'expired',
      user: { email: 'researcher@example.com' },
    });
  });
});

describe('ProfileMessageBuilder included-access usage', () => {
  beforeEach(() => {
    serverSideKeyService.getUseIncludedModelAccess.mockReturnValue(false);
    serverSideKeyService.getSpendingStatus.mockReturnValue(null);
    serverSideKeyService.refreshSpendingStatus.mockClear();
    serverSideKeyService.canUseServerSideKeys.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports usage in personal mode, where the access check never primes it', async () => {
    stubAuthenticatedRelayUser('Ultra');
    const spend = { currentSpend: 12, limit: 100, remaining: 88 };
    serverSideKeyService.getSpendingStatus.mockReturnValue(spend);

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(serverSideKeyService.canUseServerSideKeys).not.toHaveBeenCalled();
    expect(serverSideKeyService.refreshSpendingStatus).toHaveBeenCalledOnce();
    expect(message).toMatchObject({
      apiAccessMode: 'personal',
      spendingStatus: spend,
    });
  });

  it('refreshes usage in included mode too', async () => {
    stubAuthenticatedRelayUser('Ultra');
    serverSideKeyService.getUseIncludedModelAccess.mockReturnValue(true);

    await buildProfileMessage({ getProviderKeyStatuses: async () => [] });

    expect(serverSideKeyService.canUseServerSideKeys).toHaveBeenCalledOnce();
    expect(serverSideKeyService.refreshSpendingStatus).toHaveBeenCalledOnce();
  });
});
