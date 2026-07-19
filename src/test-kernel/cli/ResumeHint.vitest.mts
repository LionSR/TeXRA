import { describe, expect, it } from 'vitest';

import {
  collectResumeUsage,
  collectResumeTargets,
  formatResumeCommand,
  formatResumeHint,
  formatResumeUsage,
  type ResumeUsageStats,
} from '@cli/chat/tui/state/resumeHint';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import {
  buildChildStreamEntries,
  type ChildStreamEntryRow,
} from '@test/support/childStreamEntries';

function makeSlice(
  over: Partial<StreamSlice> & { streamId: string },
): StreamSlice {
  return {
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    activeProcesses: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...over,
    streamId: over.streamId as StreamTabId,
  };
}

function child(
  over: Partial<ChildStreamEntryRow> & {
    executionId: string;
    childStreamId: StreamTabId;
  },
): ChildStreamEntryRow {
  return { kind: 'subagent', agentName: 'agent', ...over };
}

function streamsOf(
  ...slices: StreamSlice[]
): ReadonlyMap<StreamTabId, StreamSlice> {
  return new Map(slices.map((s) => [s.streamId, s]));
}

const EMPTY_CHILD_STREAM_ENTRIES = buildChildStreamEntries({
  parentStreamId: 'main@m#root' as StreamTabId,
});

describe('collectResumeTargets', () => {
  it('returns just the main session when there are no subagents', () => {
    const streams = streamsOf(makeSlice({ streamId: 'main@m#root' }));
    expect(
      collectResumeTargets({
        childStreamEntries: EMPTY_CHILD_STREAM_ENTRIES,
        rootExecutionId: 'root',
        streams,
      }),
    ).toEqual([{ executionId: 'root', label: 'main', isRoot: true }]);
  });

  it('lists tool-use subagents and excludes workflow children', () => {
    const root = makeSlice({ streamId: 'main@m#root' });
    const reviewer = makeSlice({
      streamId: 'reviewer@m#rev',
      category: AgentCategory.ToolUse,
    });
    const builder = makeSlice({
      streamId: 'builder@m#flow',
      category: AgentCategory.Workflow,
    });
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root.streamId,
      retained: [
        child({
          executionId: 'rev',
          agentName: 'reviewer',
          childStreamId: 'reviewer@m#rev' as StreamTabId,
        }),
        child({
          executionId: 'flow',
          agentName: 'builder',
          childStreamId: 'builder@m#flow' as StreamTabId,
        }),
      ],
    });

    expect(
      collectResumeTargets({
        childStreamEntries,
        rootExecutionId: 'root',
        streams: streamsOf(root, reviewer, builder),
      }),
    ).toEqual([
      { executionId: 'root', label: 'main', isRoot: true },
      { executionId: 'rev', label: 'reviewer', isRoot: false },
    ]);
  });

  it('skips children whose stream never reported a category (processes/unknown)', () => {
    const root = makeSlice({ streamId: 'main@m#root' });
    const shell = makeSlice({ streamId: 'bash@tool#sh' }); // category undefined
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root.streamId,
      retained: [
        child({
          executionId: 'sh',
          agentName: 'bash',
          childStreamId: 'bash@tool#sh' as StreamTabId,
        }),
      ],
    });

    expect(
      collectResumeTargets({
        childStreamEntries,
        rootExecutionId: 'root',
        streams: streamsOf(root, shell),
      }),
    ).toEqual([{ executionId: 'root', label: 'main', isRoot: true }]);
  });

  it('returns nothing when there is no root execution yet', () => {
    expect(
      collectResumeTargets({
        childStreamEntries: EMPTY_CHILD_STREAM_ENTRIES,
        rootExecutionId: undefined,
        streams: new Map(),
      }),
    ).toEqual([]);
  });
});

describe('formatResumeHint', () => {
  it('formats resume commands with a local launcher when provided', () => {
    expect(formatResumeCommand(undefined, 'root')).toBe('texra resume root');
    expect(formatResumeCommand('texra-local', 'root')).toBe(
      'texra-local resume root',
    );
  });

  it('adds a quoted cwd when the session workspace differs from the shell cwd', () => {
    expect(
      formatResumeCommand('texra-local', 'root', {
        cwd: "/tmp/texra user's paper",
        processCwd: '/tmp/launcher',
      }),
    ).toBe('texra-local resume root --cwd "/tmp/texra user\'s paper"');
  });

  it('omits cwd when the resume command is already printed from that workspace', () => {
    expect(
      formatResumeCommand('texra-local', 'root', {
        cwd: '/tmp/paper',
        processCwd: '/tmp/paper',
      }),
    ).toBe('texra-local resume root');
  });

  it('preserves non-default approval policies in resume commands', () => {
    expect(
      formatResumeCommand('texra-local', 'root', { approvalPolicy: 'ask' }),
    ).toBe('texra-local resume root');
    expect(
      formatResumeCommand('texra-local', 'root', { approvalPolicy: 'never' }),
    ).toBe('texra-local resume root --approval-policy never');
    expect(
      formatResumeCommand(undefined, 'root', { approvalPolicy: 'yolo' }),
    ).toBe('texra resume root --approval-policy yolo');
  });

  it('includes both cwd and approval policy when both are needed', () => {
    expect(
      formatResumeCommand('texra-local', 'root', {
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
        approvalPolicy: 'never',
      }),
    ).toBe('texra-local resume root --cwd /tmp/paper --approval-policy never');
  });

  it('renders one resume line per target', () => {
    expect(
      formatResumeHint([
        { executionId: 'root', label: 'main', isRoot: true },
        { executionId: 'rev', label: 'reviewer', isRoot: false },
      ]),
    ).toBe(
      [
        'Resume this session with:',
        '  texra resume root  (main)',
        '  texra resume rev  (reviewer)',
      ].join('\n'),
    );
  });

  it('uses the provided command name for every resume target', () => {
    expect(
      formatResumeHint(
        [
          { executionId: 'root', label: 'main', isRoot: true },
          { executionId: 'rev', label: 'reviewer', isRoot: false },
        ],
        undefined,
        'texra-local',
        { approvalPolicy: 'never' },
      ),
    ).toBe(
      [
        'Resume this session with:',
        '  texra-local resume root --approval-policy never  (main)',
        '  texra-local resume rev --approval-policy never  (reviewer)',
      ].join('\n'),
    );
  });

  it('includes cwd on every resume target when needed', () => {
    expect(
      formatResumeHint(
        [
          { executionId: 'root', label: 'main', isRoot: true },
          { executionId: 'rev', label: 'reviewer', isRoot: false },
        ],
        undefined,
        'texra-local',
        { cwd: '/tmp/paper', processCwd: '/tmp/launcher' },
      ),
    ).toBe(
      [
        'Resume this session with:',
        '  texra-local resume root --cwd /tmp/paper  (main)',
        '  texra-local resume rev --cwd /tmp/paper  (reviewer)',
      ].join('\n'),
    );
  });

  it('prepends token usage when available', () => {
    expect(
      formatResumeHint([{ executionId: 'root', label: 'main', isRoot: true }], {
        inputTokens: 186_189_742,
        outputTokens: 11_042_600,
        cost: 0,
        cacheReadInputTokens: 6_470_327_168,
        reasoningTokens: 3_489_148,
      } satisfies ResumeUsageStats),
    ).toBe(
      [
        'Token usage: total=197,232,342 input=186,189,742 (+ 6,470,327,168 cached) output=11,042,600 (reasoning 3,489,148)',
        'Resume this session with:',
        '  texra resume root  (main)',
      ].join('\n'),
    );
  });

  it('is undefined when there is nothing to resume', () => {
    expect(formatResumeHint([])).toBeUndefined();
  });
});

describe('collectResumeUsage', () => {
  it('sums usage from every stream', () => {
    const streams = streamsOf(
      makeSlice({
        streamId: 'main@m#root',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cost: 0.2,
          cacheReadInputTokens: 7,
        },
      }),
      makeSlice({
        streamId: 'review@m#rev',
        usage: {
          inputTokens: 40,
          outputTokens: 8,
          cost: 0.3,
          cacheReadInputTokens: 3,
          reasoningTokens: 5,
        } as ResumeUsageStats,
      }),
    );

    expect(collectResumeUsage(streams)).toEqual({
      inputTokens: 140,
      outputTokens: 28,
      cost: 0.5,
      cacheReadInputTokens: 10,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 5,
    });
  });

  it('prefers cumulative usage over the latest status-bar snapshot', () => {
    const streams = streamsOf(
      makeSlice({
        streamId: 'main@m#root',
        usage: {
          inputTokens: 40,
          outputTokens: 8,
          cost: 0.1,
        },
        cumulativeUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cost: 0.3,
        },
      }),
    );

    expect(collectResumeUsage(streams)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.3,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});

describe('formatResumeUsage', () => {
  it('omits empty usage', () => {
    expect(
      formatResumeUsage({ inputTokens: 0, outputTokens: 0, cost: 0 }),
    ).toBeUndefined();
  });
});
