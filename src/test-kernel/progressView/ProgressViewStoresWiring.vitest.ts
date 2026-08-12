// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { defaultSession } from '@agent/runtime/SessionHandle';
import { SessionState } from '@controllers/session/SessionState';
import type { StreamTabId } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';

describe('SessionState session-store wiring', () => {
  it('clears session status for a stores-initiated canonical deletion', async () => {
    const session = defaultSession();
    const state = new SessionState(new FakeStateStore());
    const stream = 'swept-stream' as StreamTabId;
    session.transcripts.ensureStream(stream);
    expect(session.status.tryAcquire(stream)).toBe(true);

    await expect(state.stores.deleteStream(stream)).resolves.toBe('deleted');

    expect(session.status.get(stream)).toBeUndefined();
  });
});
