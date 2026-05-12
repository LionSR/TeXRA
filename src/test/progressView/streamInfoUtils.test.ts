// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { compareByNewestCreationTime } from '@progressView/streamOrdering';
import type { StreamTabInfo } from '@shared/schemas';

function streamInfo(name: string, creationTimestamp: number): StreamTabInfo {
  return {
    name,
    label: name,
    agentCategory: 'workflow',
    creationTimestamp,
  };
}

describe('compareByNewestCreationTime', () => {
  it('orders streams newest first by creation time', () => {
    const streams = [streamInfo('older', 100), streamInfo('newer', 200)].sort(
      compareByNewestCreationTime,
    );

    assert.deepEqual(
      streams.map((stream) => stream.name),
      ['newer', 'older'],
    );
  });

  it('uses stream name as a stable tie-breaker', () => {
    const streams = [
      streamInfo('b-stream', 100),
      streamInfo('a-stream', 100),
    ].sort(compareByNewestCreationTime);

    assert.deepEqual(
      streams.map((stream) => stream.name),
      ['a-stream', 'b-stream'],
    );
  });
});
