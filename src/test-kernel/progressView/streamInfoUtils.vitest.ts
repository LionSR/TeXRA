// Suites for src/controllers/progressView/backend stream info helpers
// (streamOrdering + streamTabInfo).

import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { compareByNewestCreationTime } from '@controllers/progressView/backend/streamOrdering';
import { buildStreamTabInfo } from '@controllers/progressView/backend/streamTabInfo';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

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
      metadata: {
        agentCategory: AgentCategory.ToolUse,
        creationTimestamp: 1,
      },
    });

    expect(info.label).toBe('bash');
    expect(info.agent).toBe('bash');
    expect(info.kind).toBe('process');
  });

  it('renders the canonical category and remote status without source precedence', () => {
    const info = buildStreamTabInfo({
      streamId: 'search@deepseek#exec',
      metadata: {
        agent: 'search',
        agentCategory: AgentCategory.ToolUse,
        isRemote: true,
        creationTimestamp: 1,
      },
    });

    expect(info.agentCategory).toBe(AgentCategory.ToolUse);
    expect(info.isRemote).toBe(true);
  });
});
