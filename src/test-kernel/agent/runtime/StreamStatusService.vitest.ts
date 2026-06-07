// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('StreamStatusRegistry', () => {
  it('keeps stream status state per instance', () => {
    const first = new StreamStatusRegistry();
    const second = new StreamStatusRegistry();
    const streamId = 'stream-status-instance-test' as StreamTabId;

    first.set(streamId, STREAM_STATUS.WAITING, { emit: false });

    expect(first.get(streamId)).toBe(STREAM_STATUS.WAITING);
    expect(second.get(streamId)).toBeUndefined();
  });

  it('keeps listeners per instance', () => {
    const first = new StreamStatusRegistry();
    const second = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-listener-test' as StreamTabId;
    const changes: string[] = [];

    first.onDidChange((change) => changes.push(change.streamId));
    second.set(streamId, STREAM_STATUS.WAITING, {
      runtimeHost: explicit.host,
    });

    expect(changes).toEqual([]);
    expect(explicit.events.map((entry) => entry.event)).toEqual([
      'updateStreamStatus',
    ]);
  });
});
