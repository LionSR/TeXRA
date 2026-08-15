import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSubscriptionSessionStatus,
  type SessionAccessCoordinator,
} from '@auth/oauth/sessionAccess';
import * as logger from '@logger/logUtils';

function coordinator(
  overrides: Partial<SessionAccessCoordinator> = {},
): SessionAccessCoordinator {
  return {
    getStatus: async () => ({ signedIn: false }),
    getFreshAccessToken: async () => 'access-token',
    loadSession: async () => null,
    ...overrides,
  };
}

describe('getSubscriptionSessionStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns on the caller-supplied channel and reports signed-out when the status read fails (#10635)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const failing = coordinator({
      getStatus: async () => {
        throw new Error('secret store unavailable');
      },
    });

    const status = await getSubscriptionSessionStatus(
      () => failing,
      'subscriptionStatusProbe',
      'ChatGPT',
    );

    expect(status).toEqual({ signedIn: false });
    expect(warn).toHaveBeenCalledWith(
      'subscriptionStatusProbe',
      expect.stringContaining(
        'Failed to read ChatGPT session status: secret store unavailable',
      ),
    );
  });

  it('passes a healthy coordinator status through without logging', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const healthy = coordinator({
      getStatus: async () => ({ signedIn: true, email: 'user@example.com' }),
    });

    const status = await getSubscriptionSessionStatus(
      () => healthy,
      'subscriptionStatusProbe',
      'ChatGPT',
    );

    expect(status).toEqual({ signedIn: true, email: 'user@example.com' });
    expect(warn).not.toHaveBeenCalled();
  });
});
