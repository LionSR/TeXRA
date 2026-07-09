// Suites for src/controllers/progressView/backend stream info helpers
// (streamOrdering + streamTabInfo).

import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { compareByNewestCreationTime } from '@controllers/progressView/backend/streamOrdering';
import {
  buildStreamTabInfo,
  pickAgentCategory,
} from '@controllers/progressView/backend/streamTabInfo';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
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

// ---------------------------------------------------------------------------
// pickAgentCategory — single owner of the config/hints agentCategory
// precedence (issue #7583). Regression coverage for the desync scenario:
// `matchesFilter`/`buildStreamInfo` (streamInfoUtils.ts), `buildStreamTabInfo`
// (streamTabInfo.ts), and `getStreamCategory` (ProgressFactApplier.ts) must
// all resolve the same category for the same config/hints inputs.
// ---------------------------------------------------------------------------

describe('pickAgentCategory', () => {
  it('prefers a live config category over the hint fallback', () => {
    expect(
      pickAgentCategory(
        { agentCategory: AgentCategory.ToolUse },
        { agentCategory: AgentCategory.Workflow },
      ),
    ).toBe(AgentCategory.ToolUse);
  });

  it('falls back to hints when config is absent', () => {
    expect(
      pickAgentCategory(undefined, { agentCategory: AgentCategory.ToolUse }),
    ).toBe(AgentCategory.ToolUse);
  });

  it('returns undefined (no default) when both sources are empty', () => {
    expect(pickAgentCategory(undefined, undefined)).toBeUndefined();
    expect(pickAgentCategory(undefined, {})).toBeUndefined();
  });

  it('agrees with buildStreamTabInfo, which layers the Workflow default on top', () => {
    const config = { agentCategory: AgentCategory.ToolUse } as AgentConfig;
    const hints = { agentCategory: AgentCategory.Workflow };

    const info = buildStreamTabInfo({
      streamId: 'search@deepseek#exec',
      config,
      hints,
      creationTimestamp: 1,
    });

    expect(pickAgentCategory(config, hints)).toBe(AgentCategory.ToolUse);
    expect(info.agentCategory).toBe(pickAgentCategory(config, hints));
  });
});
