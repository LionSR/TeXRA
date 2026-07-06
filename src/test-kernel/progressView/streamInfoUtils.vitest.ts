// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports
import type { StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/progressView/backend/streamOrdering';

function streamInfo(name: string, creationTimestamp: number): StreamTabInfo {
  return {
    kind: 'agent',
    name,
    label: name,
    agentCategory: 'workflow',
    creationTimestamp,
  };
}

describe('compareByNewestCreationTime', () => {
  it.each([
    {
      title: 'orders streams newest first by creation time',
      streams: [streamInfo('older', 100), streamInfo('newer', 200)],
      expected: ['newer', 'older'],
    },
    {
      title: 'uses stream name as a stable tie-breaker',
      streams: [streamInfo('b-stream', 100), streamInfo('a-stream', 100)],
      expected: ['a-stream', 'b-stream'],
    },
  ])('$title', ({ streams, expected }) => {
    assert.deepEqual(
      streams.sort(compareByNewestCreationTime).map((stream) => stream.name),
      expected,
    );
  });
});
