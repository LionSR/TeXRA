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
});
