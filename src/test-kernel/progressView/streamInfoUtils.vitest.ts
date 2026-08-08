// Suites for src/controllers/progressView/backend stream info helpers
// (streamOrdering + streamTabInfo).

import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { getStreamTabDisplayName } from '@agent/runtime/streamTab';
import { buildStreamTabInfo } from '@controllers/session/streamTabInfo';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';

const CHILD_STREAM_ID = 'bash@tool#exec:child-stream';

function streamInfo(name: string, creationTimestamp: number): StreamTabInfo {
  return {
    name,
    label: name,
    identity: { kind: 'agent', agent: name },
    agentCategory: 'workflow',
    creationTimestamp,
  };
}

describe('getStreamTabDisplayName', () => {
  it.each([
    { id: 'review#a4c8939992cf', expected: 'review' },
    // Legacy ids carried an `@model` segment; it stays in the display name
    // rather than being parsed further — only the hash suffix comes off.
    {
      id: 'orchestrator@opus46T#bf8234a371db',
      expected: 'orchestrator@opus46T',
    },
    // An executionId may itself contain '#': the *first* separator wins, so
    // none of the executionId leaks into the label.
    { id: 'bash@tool#exec#child', expected: 'bash@tool' },
    // Not a minted id — shown verbatim rather than blanked.
    { id: 'no-separator', expected: 'no-separator' },
    { id: '#leading', expected: '#leading' },
  ])('$id → $expected', ({ id, expected }) => {
    expect(getStreamTabDisplayName(id)).toBe(expected);
  });
});

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
      streamId: CHILD_STREAM_ID,
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
      streamId: CHILD_STREAM_ID,
      metadata: {
        creationTimestamp: 1,
      },
    });

    // Labelled by the id's human-orienting prefix, not the whole handle —
    // same shape a resolved run gets. The full id stays on `name`.
    expect(info.label).toBe('bash@tool');
    expect(info.name).toBe(CHILD_STREAM_ID);
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
