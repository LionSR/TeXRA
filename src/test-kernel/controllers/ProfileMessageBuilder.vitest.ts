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

describe('ProfileMessageBuilder session problems', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks an authoritatively rejected stored session as expired', async () => {
    vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(false);
    vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
      'invalid',
    );
    vi.spyOn(SupabaseClient, 'getStoredAccountLabel').mockResolvedValue(
      'researcher@example.com',
    );

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(message).toMatchObject({
      authenticated: false,
      sessionProblem: 'expired',
      user: { email: 'researcher@example.com' },
    });
  });

  it('preserves a stored session during a transient refresh outage', async () => {
    vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(false);
    vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
      'transient',
    );
    vi.spyOn(SupabaseClient, 'getStoredAccountLabel').mockResolvedValue(
      'researcher@example.com',
    );

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
    vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
    vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
      'invalid',
    );
    vi.spyOn(SupabaseClient, 'getStoredAccountLabel').mockResolvedValue(
      'researcher@example.com',
    );
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
