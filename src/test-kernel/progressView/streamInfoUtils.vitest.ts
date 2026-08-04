// Suites for src/controllers/progressView/backend stream info helpers
// (streamOrdering + streamTabInfo).

import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { buildStreamTabInfo } from '@controllers/progressView/backend/streamTabInfo';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';

function streamInfo(name: string, creationTimestamp: number): StreamTabInfo {
  return {
    name,
    label: name,
    identity: { kind: 'agent', agent: name },
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

describe('buildStreamTabInfo', () => {
  it('labels a process stream from its identity and surfaces the command', () => {
    const info = buildStreamTabInfo({
      streamId: 'bash@tool#exec:child-stream',
      metadata: {
        identity: { kind: 'process', tool: 'bash' },
        config: { instruction: 'ls -la' },
        agentCategory: AgentCategory.ToolUse,
        creationTimestamp: 1,
      },
    });

    expect(info.label).toBe('bash');
    expect(info.identity).toEqual({ kind: 'process', tool: 'bash' });
    expect(info.command).toBe('ls -la');
    expect(info.model).toBeUndefined();
  });

  it('renders a pending tab when the identity has not resolved yet', () => {
    const info = buildStreamTabInfo({
      streamId: 'bash@tool#exec:child-stream',
      metadata: {
        creationTimestamp: 1,
      },
    });

    expect(info.label).toBe('bash@tool#exec:child-stream');
    expect(info.identity).toBeUndefined();
    expect(info.agentCategory).toBeUndefined();
  });

  it('renders the canonical category and remote status without source precedence', () => {
    const info = buildStreamTabInfo({
      streamId: 'search@deepseek#exec',
      metadata: {
        identity: { kind: 'agent', agent: 'search' },
        config: { instruction: '', model: '' },
        agentCategory: AgentCategory.ToolUse,
        isRemote: true,
        creationTimestamp: 1,
      },
    });

    expect(info.agentCategory).toBe(AgentCategory.ToolUse);
    expect(info.isRemote).toBe(true);
  });
});
