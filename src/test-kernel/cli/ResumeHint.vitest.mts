import { describe, expect, it } from 'vitest';

import {
  collectResumeTargets,
  formatResumeHint,
} from '@cli/chat/tui/state/resumeHint';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  AGENT_CATEGORY,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';

function makeSlice(
  over: Partial<StreamSlice> & { streamId: string },
): StreamSlice {
  return {
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    usage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...over,
    streamId: over.streamId as StreamTabId,
  };
}

function child(
  over: Partial<ActiveChildInfo> & { executionId: string },
): ActiveChildInfo {
  return { agentName: 'agent', ...over };
}

function streamsOf(
  ...slices: StreamSlice[]
): ReadonlyMap<StreamTabId, StreamSlice> {
  return new Map(slices.map((s) => [s.streamId, s]));
}

describe('collectResumeTargets', () => {
  it('returns just the main session when there are no subagents', () => {
    const streams = streamsOf(makeSlice({ streamId: 'main@m#root' }));
    expect(collectResumeTargets({ rootExecutionId: 'root', streams })).toEqual([
      { executionId: 'root', label: 'main', isRoot: true },
    ]);
  });

  it('lists tool-use subagents and excludes workflow children', () => {
    const root = makeSlice({
      streamId: 'main@m#root',
      childStreams: [
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
    const reviewer = makeSlice({
      streamId: 'reviewer@m#rev',
      category: AGENT_CATEGORY.TOOL_USE,
    });
    const builder = makeSlice({
      streamId: 'builder@m#flow',
      category: AGENT_CATEGORY.WORKFLOW,
    });

    expect(
      collectResumeTargets({
        rootExecutionId: 'root',
        streams: streamsOf(root, reviewer, builder),
      }),
    ).toEqual([
      { executionId: 'root', label: 'main', isRoot: true },
      { executionId: 'rev', label: 'reviewer', isRoot: false },
    ]);
  });

  it('skips children whose stream never reported a category (processes/unknown)', () => {
    const root = makeSlice({
      streamId: 'main@m#root',
      childStreams: [
        child({
          executionId: 'sh',
          agentName: 'bash',
          childStreamId: 'bash@tool#sh' as StreamTabId,
        }),
      ],
    });
    const shell = makeSlice({ streamId: 'bash@tool#sh' }); // category undefined
    expect(
      collectResumeTargets({
        rootExecutionId: 'root',
        streams: streamsOf(root, shell),
      }),
    ).toEqual([{ executionId: 'root', label: 'main', isRoot: true }]);
  });

  it('returns nothing when there is no root execution yet', () => {
    expect(
      collectResumeTargets({ rootExecutionId: undefined, streams: new Map() }),
    ).toEqual([]);
  });
});

describe('formatResumeHint', () => {
  it('renders one resume line per target', () => {
    expect(
      formatResumeHint([
        { executionId: 'root', label: 'main', isRoot: true },
        { executionId: 'rev', label: 'reviewer', isRoot: false },
      ]),
    ).toBe(
      [
        'Resume this session with:',
        '  texra --resume root  (main)',
        '  texra --resume rev  (reviewer)',
      ].join('\n'),
    );
  });

  it('is undefined when there is nothing to resume', () => {
    expect(formatResumeHint([])).toBeUndefined();
  });
});
