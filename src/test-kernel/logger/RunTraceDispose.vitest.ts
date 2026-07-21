import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_TYPES } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';

describe('createRunTrace dispose', () => {
  let store: StreamLogStore;

  beforeEach(() => {
    store = StreamLogStore.ephemeral('test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the flusher from its owning session set on dispose', () => {
    vi.useFakeTimers();
    const flushers = new Map<string, () => void>();
    const handle = createRunTrace('disposed-stream', store, flushers);
    const stream = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

    stream.append('a');
    // Chunk is throttled (49ms window), but the owning session set reaches it.
    for (const flush of flushers.values()) flush();
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');

    handle.dispose();

    // After dispose: more chunks should not reach the store via the global
    // flusher (because the flusher was removed from `activeFlushers`).
    // Append another chunk and confirm the owning set no longer pushes
    // it through. The chunk would still flush via its own per-stream timer,
    // so we verify by sampling before the timer fires.
    stream.append('b');
    for (const flush of flushers.values()) flush();
    // Only the 'a' chunk should be visible — the 'b' chunk hasn't been
    // pushed because the flusher was unregistered and the throttled timer
    // hasn't fired.
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');
  });

  it('returns the same dispose function across the handle', () => {
    const handle = createRunTrace('idempotent-stream', store);
    handle.dispose();
    // Calling dispose again should not throw and should be a no-op.
    expect(() => handle.dispose()).not.toThrow();
  });
});
