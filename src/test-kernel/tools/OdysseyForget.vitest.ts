import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import type { StreamTabId } from '@shared/schemas';
import { OdysseyStore } from '@tools/odyssey';

const STREAM_A = 'stream:forget-a' as StreamTabId;
const STREAM_B = 'stream:forget-b' as StreamTabId;

describe('OdysseyStore.forget (abandon-on-delete contract)', () => {
  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));
  });

  afterEach(async () => {
    await OdysseyStore.forget(STREAM_A);
    await OdysseyStore.forget(STREAM_B);
  });

  it('removes the per-stream record and clears the index entry', async () => {
    await OdysseyStore.start(STREAM_A, 'objective a');
    await OdysseyStore.start(STREAM_B, 'objective b');
    expect(
      OdysseyStore.list()
        .map((o) => o.streamId)
        .sort(),
    ).toEqual([STREAM_A, STREAM_B].sort());

    await OdysseyStore.forget(STREAM_A);

    expect(OdysseyStore.getForStream(STREAM_A)).toBeNull();
    expect(OdysseyStore.list().map((o) => o.streamId)).toEqual([STREAM_B]);
  });

  it('is idempotent — forgetting an unknown stream is a no-op', async () => {
    await expect(OdysseyStore.forget(STREAM_A)).resolves.toBeUndefined();
  });

  it('lets the same streamId start a fresh odyssey after forget', async () => {
    await OdysseyStore.start(STREAM_A, 'objective one');
    await OdysseyStore.forget(STREAM_A);
    const next = await OdysseyStore.start(STREAM_A, 'objective two');
    expect(next.objective).toBe('objective two');
    expect(next.status).toBe('active');
  });
});
