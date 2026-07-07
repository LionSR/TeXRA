// Suites for src/shared/progressView/backend stream info helpers
// (streamOrdering + streamTabInfo).

import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/progressView/backend/streamOrdering';
import { buildStreamTabInfo } from '@shared/progressView/backend/streamTabInfo';

// ---------------------------------------------------------------------------
// streamInfoUtils
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// StreamTabInfo
// ---------------------------------------------------------------------------

describe('buildStreamTabInfo', () => {
  it('classifies stream-id-derived bash child streams as process agents', () => {
    const info = buildStreamTabInfo({
      streamId: 'bash@tool#exec:child-stream',
      hints: {
        agentCategory: AgentCategory.ToolUse,
      },
      creationTimestamp: 1,
    });

    expect(info.label).toBe('bash');
    expect(info.agent).toBe('bash');
    expect(info.kind).toBe('process');
  });
});
