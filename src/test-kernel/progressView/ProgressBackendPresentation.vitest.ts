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
  it('loads a presentation without reloading its live transcript', async () => {
    const session = await createLiveStoreSession();
    const waitUntilReady = vi.spyOn(session, 'waitUntilReady');
    const reload = vi.spyOn(session.transcripts, 'reload');
    const { backend } = createIsolatedRecordingBackend(session);

    await backend.load();

    expect(waitUntilReady).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
