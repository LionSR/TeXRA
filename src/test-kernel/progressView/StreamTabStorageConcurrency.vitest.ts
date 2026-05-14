import { describe, expect, it } from 'vitest';

import {
  mapStreamTabStorage,
  STREAM_TAB_IO_CONCURRENCY,
} from '@progressView/persistence/StreamTabStore';
import type { StreamTabId } from '@shared/schemas';

describe('mapStreamTabStorage', () => {
  it('bounds concurrent per-stream storage work', async () => {
    const streamIds = Array.from(
      { length: STREAM_TAB_IO_CONCURRENCY + 4 },
      (_, index) => `stream-${index}` as StreamTabId,
    );
    const pending: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let started = 0;

    const resultPromise = mapStreamTabStorage(streamIds, async (streamId) => {
      active++;
      started++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
      return streamId;
    });

    await waitFor(() => started === STREAM_TAB_IO_CONCURRENCY);
    expect(maxActive).toBe(STREAM_TAB_IO_CONCURRENCY);
    expect(started).toBe(STREAM_TAB_IO_CONCURRENCY);

    while (started < streamIds.length) {
      for (const resolve of pending.splice(0)) {
        resolve();
      }
      await waitFor(() => pending.length > 0 || started === streamIds.length);
    }

    for (const resolve of pending.splice(0)) {
      resolve();
      await Promise.resolve();
    }

    const results = await resultPromise;
    expect(results).toEqual(streamIds);
    expect(maxActive).toBeLessThanOrEqual(STREAM_TAB_IO_CONCURRENCY);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}
