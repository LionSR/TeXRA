import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@utils/config/providerConfig', () => ({
  getGlobalStreaming: () => true,
}));

import { SupabaseClient } from '@auth/SupabaseClient';
import { buildProfileMessage } from '@controllers/settingsView/ProfileMessageBuilder';

type StoredSessionState = Awaited<
  ReturnType<typeof SupabaseClient.getStoredSessionState>
>;

function stubStoredSession(sessionState: StoredSessionState): void {
  vi.spyOn(SupabaseClient, 'getStoredSessionState').mockResolvedValue(
    sessionState,
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
    stubStoredSession('invalid');
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
    stubStoredSession('transient');

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(message).toMatchObject({
      authenticated: false,
      sessionProblem: 'unavailable',
      user: { email: 'researcher@example.com' },
    });
  });
});
