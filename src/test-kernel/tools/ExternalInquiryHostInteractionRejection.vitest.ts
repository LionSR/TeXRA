// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { ExternalInquiryTool } from '@tools/inquiry/ExternalInquiryTool';

const STREAM = 'stream:inquiry-host-interaction' as StreamTabId;

describe('ExternalInquiryTool host interaction dispatch', () => {
  // Tool writes a new thread manifest to storage; keep state isolated.
  setupPlatform();

  it('surfaces a rejected openExternalInquiry() as a tool error instead of an unhandled rejection', async () => {
    const session = createTestSession();
    const parentLease = session.followUps.claimLive(STREAM, 'flow')!;
    session.useHostInteractions({
      cancel: () => {},
      openExternalInquiry: () =>
        Promise.reject(new Error('external inquiry panel unavailable')),
    });

    try {
      const result = await withRunContext(
        createRunContext({ streamId: STREAM, session }),
        () =>
          new ExternalInquiryTool().call({
            command: 'ask',
            question:
              'Does a synchronous panel failure surface as a tool error?',
          }),
      );

      // Before the fix, `void interaction` dropped the rejection: the promise
      // was never awaited or attached to a .catch(), so the tool call proceeded
      // to `status: 'executed'` and the rejection surfaced later as a process
      // level unhandled rejection instead of a tool error result.
      expect(result.status).toBe('error');
      expect(result.error).toContain('external inquiry panel unavailable');
    } finally {
      session.followUps.release(parentLease, 'terminal');
      session.dispose();
    }
  });
});
