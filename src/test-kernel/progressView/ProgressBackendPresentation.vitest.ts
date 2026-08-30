/**
 * Presentation loading: what `load()` reads, and what it must not reopen.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import {
  createIsolatedRecordingBackend,
  createLiveStoreSession,
} from './progressBackendHarness';

describe('ProgressBackend', () => {
  it('loads a presentation by waiting for the live transcript', async () => {
    const session = await createLiveStoreSession();
    const waitUntilReady = vi.spyOn(session, 'waitUntilReady');
    const { backend } = createIsolatedRecordingBackend(session);

    await backend.load();

    // The companion `reload` assertion retired with StreamLogStore.reload:
    // a re-read is no longer expressible, so it cannot be asserted against.
    expect(waitUntilReady).toHaveBeenCalledOnce();
  });
});
