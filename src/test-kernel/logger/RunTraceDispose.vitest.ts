import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunTrace,
  flushPendingRunTraces,
  StreamLogStore,
} from '@transcript';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('createRunTrace dispose', () => {
  let store: StreamLogStore;

  beforeEach(() => {
    store = StreamLogStore.ephemeral('test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the flusher from the global registry on dispose', () => {
    vi.useFakeTimers();
    const handle = createRunTrace('disposed-stream', store);
    const stream = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

    stream.append('a');
    // Chunk is throttled (49ms window) — `flushPendingRunTraces` reaches it
    // through the module-global `activeFlushers` set.
    flushPendingRunTraces();
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');

    handle.dispose();

    // After dispose: more chunks should not reach the store via the global
    // flusher (because the flusher was removed from `activeFlushers`).
    // Append another chunk and confirm `flushPendingRunTraces` doesn't push
    // it through. The chunk would still flush via its own per-stream timer,
    // so we verify by sampling before the timer fires.
    stream.append('b');
    flushPendingRunTraces();
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
