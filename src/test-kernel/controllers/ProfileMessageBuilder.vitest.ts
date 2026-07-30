// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent/index', () => ({
  getAgentsBySource: vi.fn(() => []),
  loadAgents: vi.fn(async () => {}),
  toRemoteAgentProfileData: vi.fn(),
}));

vi.mock('@utils/config/providerConfig', () => ({
  getGlobalStreaming: () => true,
}));

// Local imports
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
