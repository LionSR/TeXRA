import { describe, expect, it } from 'vitest';

import {
  collectResumeUsage,
  collectResumeTargets,
  formatResumeCommand,
  formatResumeHint,
  formatResumeUsage,
  type ResumeCommandOptions,
  type ResumeTarget,
} from '@cli/chat/tui/state/resumeHint';
import { emptySlice, type StreamSlice } from '@cli/chat/tui/state/cliState';
import { type StreamTabId, type TokenUsageStats } from '@shared/schemas';
import {
  buildChildStreamEntries,
  type ChildStreamEntryRow,
} from '@test/support/childStreamEntries';

function makeSlice(
  over: Partial<StreamSlice> & { streamId: string },
): StreamSlice {
  return {
    ...emptySlice(over.streamId as StreamTabId),
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
  return {
    agentName: 'agent',
    identity: { kind: 'agent', agent: 'agent' },
    resumeEligible: true,
    ...over,
  };
}

function streamsOf(
  ...slices: StreamSlice[]
): ReadonlyMap<StreamTabId, StreamSlice> {
  return new Map(slices.map((s) => [s.streamId, s]));
}

const EMPTY_CHILD_STREAM_ENTRIES = buildChildStreamEntries({
  parentStreamId: 'main@m#root' as StreamTabId,
});

/** Root plus one subagent — the shared fixture for multi-line hint cases. */
const TWO_RESUME_TARGETS: readonly ResumeTarget[] = [
  { executionId: 'root', label: 'main', isRoot: true },
  { executionId: 'rev', label: 'reviewer', isRoot: false },
];

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

  it('lists resume-eligible subagents and excludes ineligible children', () => {
    const root = makeSlice({ streamId: 'main@m#root' });
    const reviewer = makeSlice({ streamId: 'reviewer@m#rev' });
    const builder = makeSlice({ streamId: 'builder@m#flow' });
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root.streamId,
      retained: [
        child({
          executionId: 'rev',
          agentName: 'reviewer',
          identity: { kind: 'agent', agent: 'reviewer' },
          childStreamId: 'reviewer@m#rev' as StreamTabId,
        }),
        child({
          executionId: 'flow',
          agentName: 'builder',
          identity: { kind: 'agent', agent: 'builder' },
          resumeEligible: false,
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

  it('skips children whose roster row has no resume eligibility', () => {
    const root = makeSlice({ streamId: 'main@m#root' });
    const shell = makeSlice({ streamId: 'bash@tool#sh' });
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root.streamId,
      retained: [
        child({
          executionId: 'sh',
          agentName: 'bash',
          resumeEligible: undefined,
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
  it.each<{
    name: string;
    commandName: string | undefined;
    options?: ResumeCommandOptions;
    expected: string;
  }>([
    {
      name: 'falls back to the default texra command name',
      commandName: undefined,
      expected: 'texra resume root',
    },
    {
      name: 'uses a local launcher when provided',
      commandName: 'texra-local',
      expected: 'texra-local resume root',
    },
    {
      name: 'adds a quoted cwd when the session workspace differs from the shell cwd',
      commandName: 'texra-local',
      options: { cwd: "/tmp/texra user's paper", processCwd: '/tmp/launcher' },
      expected: 'texra-local resume root --cwd "/tmp/texra user\'s paper"',
    },
    {
      name: 'omits cwd when the resume command is already printed from that workspace',
      commandName: 'texra-local',
      options: { cwd: '/tmp/paper', processCwd: '/tmp/paper' },
      expected: 'texra-local resume root',
    },
    {
      name: 'preserves whitespace in a stored workspace path',
      commandName: 'texra-local',
      options: { cwd: '/tmp/paper ', processCwd: '/tmp/launcher' },
      expected: "texra-local resume root --cwd '/tmp/paper '",
    },
    {
      name: 'omits the default approval policy',
      commandName: 'texra-local',
      options: { approvalPolicy: 'ask' },
      expected: 'texra-local resume root',
    },
    {
      name: 'preserves a non-default approval policy',
      commandName: 'texra-local',
      options: { approvalPolicy: 'never' },
      expected: 'texra-local resume root --approval-policy never',
    },
    {
      name: 'preserves a non-default approval policy with the default command name',
      commandName: undefined,
      options: { approvalPolicy: 'yolo' },
      expected: 'texra resume root --approval-policy yolo',
    },
    {
      name: 'preserves a non-default output format',
      commandName: 'texra-local',
      options: { outputFormat: 'ndjson' },
      expected: 'texra-local resume root --output-format ndjson',
    },
    {
      name: 'preserves headless mode and custom skill sources',
      commandName: 'texra-local',
      options: {
        print: true,
        includeInteropSkills: true,
        skillSourcePaths: ['/tmp/shared skills', './local-skills'],
      },
      expected:
        "texra-local resume root --print --include-interop --source '/tmp/shared skills' --source ./local-skills",
    },
    {
      name: 'includes both cwd and approval policy when both are needed',
      commandName: 'texra-local',
      options: {
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
        approvalPolicy: 'never',
      },
      expected:
        'texra-local resume root --cwd /tmp/paper --approval-policy never',
    },
  ])('formats resume commands: $name', ({ commandName, options, expected }) => {
    expect(formatResumeCommand(commandName, 'root', options)).toBe(expected);
  });

  it('renders one resume line per target', () => {
    expect(formatResumeHint(TWO_RESUME_TARGETS)).toBe(
      [
        'Resume this session with:',
        '  texra resume root  (main)',
        '  texra resume rev  (reviewer)',
      ].join('\n'),
    );
  });

  it('uses the provided command name for every resume target', () => {
    expect(
      formatResumeHint(TWO_RESUME_TARGETS, undefined, 'texra-local', {
        approvalPolicy: 'never',
      }),
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
      formatResumeHint(TWO_RESUME_TARGETS, undefined, 'texra-local', {
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
      }),
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
      } satisfies TokenUsageStats),
    ).toBe(
      [
        'Token usage: total=197,232,342 input=186,189,742 (+ 6,470,327,168 cached) output=11,042,600 (reasoning 3,489,148)',
        'Resume this session with:',
        '  texra resume root  (main)',
      ].join('\n'),
    );
  });

  it('flows the session cost line through the full hint', () => {
    expect(
      formatResumeHint([{ executionId: 'root', label: 'main', isRoot: true }], {
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.012,
        usageRoute: 'relay',
      } satisfies TokenUsageStats),
    ).toBe(
      [
        'Token usage: total=120 input=100 output=20',
        'Session cost: $0.012 via included access',
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
        } as TokenUsageStats,
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
      reasoningTokens: 0,
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

  it('appends the session cost with the relay route label', () => {
    expect(
      formatResumeUsage({
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.012,
        usageRoute: 'relay',
      }),
    ).toBe(
      'Token usage: total=120 input=100 output=20\n' +
        'Session cost: $0.012 via included access',
    );
  });

  it('shows a covered subscription as free', () => {
    expect(
      formatResumeUsage({
        inputTokens: 100,
        outputTokens: 20,
        cost: 0,
        usageRoute: 'chatgpt-subscription',
      }),
    ).toBe(
      'Token usage: total=120 input=100 output=20\n' +
        'Session cost: free via ChatGPT',
    );
  });

  it('labels your own API keys', () => {
    expect(
      formatResumeUsage({
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.5,
        usageRoute: 'api-key',
      }),
    ).toBe(
      'Token usage: total=120 input=100 output=20\n' +
        'Session cost: $0.500 via your own API keys',
    );
  });

  it('shows the bare cost when no route is stamped', () => {
    expect(
      formatResumeUsage({ inputTokens: 100, outputTokens: 20, cost: 0.3 }),
    ).toBe(
      'Token usage: total=120 input=100 output=20\n' + 'Session cost: $0.300',
    );
  });

  it('omits the cost line when there is no cost and no route', () => {
    const usage = { inputTokens: 100, outputTokens: 20, cost: 0 };
    expect(formatResumeUsage(usage)).toBe(
      'Token usage: total=120 input=100 output=20',
    );
  });
});
