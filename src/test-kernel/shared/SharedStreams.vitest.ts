// Suites for src/shared/streams (child-activity reducer, stream metadata,
// status display).

import { describe, expect, it } from 'vitest';
import {
  type ActiveChildInfo,
  AgentCategory,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type StreamLifecycleStatus,
} from '@shared/schemas';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';
import {
  formatPhaseStageLabel,
  formatRoundStageLabel,
  formatStageLabel,
  formatStreamStatusLabel,
  streamStatusDisplayKey,
  streamStatusIndicatorClass,
  type StreamStatusLabelStyle,
} from '@shared/streams/streamStatusDisplay';

// ---------------------------------------------------------------------------
// ChildActivityReducer
// ---------------------------------------------------------------------------

describe('diffActiveChildren', () => {
  const cases: Array<{
    name: string;
    previous: string[];
    next: string[];
    vanished: string[];
  }> = [
    {
      name: 'reports no vanished ids when previous is empty',
      previous: [],
      next: ['a'],
      vanished: [],
    },
    {
      name: 'reports all previous ids as vanished when next is empty',
      previous: ['a', 'b'],
      next: [],
      vanished: ['a', 'b'],
    },
    {
      name: 'reports only the ids that dropped out on partial overlap',
      previous: ['a', 'b', 'c'],
      next: ['b', 'c', 'd'],
      vanished: ['a'],
    },
    {
      name: 'is unaffected by duplicate ids in either input',
      previous: ['a', 'a', 'b'],
      next: ['a'],
      vanished: ['b'],
    },
    {
      name: 'reports nothing vanished when previous and next are identical',
      previous: ['a', 'b'],
      next: ['a', 'b'],
      vanished: [],
    },
  ];

  it.each(cases)('$name', ({ previous, next, vanished }) => {
    expect(
      diffActiveChildren(
        previous.map((executionId) => ({ executionId })),
        next.map((executionId) => ({ executionId })),
      ),
    ).toEqual(new Set(vanished));
  });
});

// ---------------------------------------------------------------------------
// StreamMetadata
// ---------------------------------------------------------------------------

describe('buildStreamMetadata', () => {
  it('fills backend-owned defaults for a stream state metadata payload', () => {
    const metadata = buildStreamMetadata({ category: AgentCategory.Workflow });

    expect(metadata).toMatchObject({
      category: AgentCategory.Workflow,
      status: STREAM_STATUS.READY,
      conversationProgress: { toolCallCount: 0 },
      stage: null,
      subagents: [],
    });
    expect(Object.hasOwn(metadata, 'substate')).toBe(true);
    expect(metadata.substate).toBeUndefined();
  });

  it('preserves supplied status, progress, child roster, and timestamps', () => {
    const child: ActiveChildInfo = {
      executionId: 'agent-1',
      childStreamId: 'agent-1-stream',
      agentName: 'review',
      identity: { kind: 'agent' as const, agent: 'review' },
      status: STREAM_STATUS.RUNNING,
    };
    const finishedChild: ActiveChildInfo = {
      executionId: 'agent-0',
      childStreamId: 'agent-0-stream',
      agentName: 'review',
      identity: { kind: 'agent' as const, agent: 'review' },
      status: STREAM_PHASE.COMPLETED,
      finishedAt: 122,
    };

    expect(
      buildStreamMetadata({
        category: AgentCategory.ToolUse,
        status: STREAM_STATUS.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
        lastTimestamp: 123,
        conversationProgress: { toolCallCount: 5 },
        stage: { kind: 'round', index: 1, total: 3 },
        subagents: [child, finishedChild],
      }),
    ).toEqual({
      category: AgentCategory.ToolUse,
      status: STREAM_STATUS.RUNNING,
      substate: STREAM_SUBSTATE.STARTING,
      lastTimestamp: 123,
      conversationProgress: { toolCallCount: 5 },
      stage: { kind: 'round', index: 1, total: 3 },
      subagents: [child, finishedChild],
    });
  });

  it('carries a workflow-script phase for the run row', () => {
    expect(
      buildStreamMetadata({
        category: AgentCategory.Workflow,
        stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
      }).stage,
    ).toEqual({ kind: 'phase', label: 'Reduce', index: 1, total: 3 });
  });
});

// ---------------------------------------------------------------------------
// StreamStatusDisplay
// ---------------------------------------------------------------------------

describe('formatRoundStageLabel', () => {
  it('renders the one-based round over the planned total when known', () => {
    expect(formatRoundStageLabel({ index: 1, total: 3 })).toBe('r2/3');
  });

  it('renders the bare round when no total is planned', () => {
    expect(formatRoundStageLabel({ index: 0 })).toBe('r1');
  });

  it('passes undefined through for streams without a round', () => {
    expect(formatRoundStageLabel(undefined)).toBeUndefined();
  });
});

describe('formatPhaseStageLabel', () => {
  it('renders the one-based phase over the declared total', () => {
    expect(formatPhaseStageLabel({ label: 'Reduce', index: 1, total: 3 })).toBe(
      'Reduce (2/3)',
    );
  });

  it('renders the bare position when no total was declared', () => {
    expect(formatPhaseStageLabel({ label: 'Reduce', index: 1 })).toBe(
      'Reduce (2)',
    );
  });

  it('renders only the title for a dynamically opened phase', () => {
    expect(formatPhaseStageLabel({ label: 'Cleanup' })).toBe('Cleanup');
  });

  it('passes undefined through for streams without a phase', () => {
    expect(formatPhaseStageLabel(undefined)).toBeUndefined();
  });
});

describe('formatStageLabel', () => {
  it('labels a round stage through the round formatter', () => {
    expect(formatStageLabel({ kind: 'round', index: 1, total: 3 })).toBe(
      'r2/3',
    );
  });

  it('labels a phase stage through the phase formatter', () => {
    expect(
      formatStageLabel({ kind: 'phase', label: 'Reduce', index: 1, total: 3 }),
    ).toBe('Reduce (2/3)');
  });

  it('passes undefined through for a stream with no stage open', () => {
    expect(formatStageLabel(undefined)).toBeUndefined();
  });
});

describe('stream status display labels', () => {
  const wordingCases: Array<
    [StreamStatusLabelStyle, StreamLifecycleStatus, string]
  > = [
    ['cli', STREAM_PHASE.WAITING, 'idle'],
    ['cliCompact', STREAM_PHASE.WAITING, 'idle'],
    ['progressHeader', STREAM_PHASE.WAITING, 'Idle'],
    ['cliCompact', STREAM_PHASE.COMPLETED, 'completed'],
    ['progressHeader', STREAM_PHASE.COMPLETED, 'Completed'],
    ['cliCompact', STREAM_PHASE.CANCELLED, 'stopped'],
    ['progressHeader', STREAM_PHASE.CANCELLED, 'Stopped'],
    ['cli', STREAM_STATUS.READY, 'ready'],
    ['progressHeader', STREAM_STATUS.READY, 'Ready'],
  ];

  it.each(wordingCases)(
    'preserves %s wording: %s -> "%s"',
    (style, status, label) => {
      expect(formatStreamStatusLabel(status, { style })).toBe(label);
    },
  );

  const substateWordingCases: Array<[StreamStatusLabelStyle, string]> = [
    ['cli', 'starting\u2026'],
    ['cliCompact', 'starting'],
    ['progressHeader', 'Initializing'],
  ];

  it.each(substateWordingCases)(
    'preserves %s STARTING wording: "%s"',
    (style, label) => {
      expect(
        formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
          style,
          substate: STREAM_SUBSTATE.STARTING,
        }),
      ).toBe(label);
    },
  );

  it('supports an explicit missing label', () => {
    expect(formatStreamStatusLabel(undefined, { missingLabel: '-' })).toBe('-');
  });

  it('uses substate display keys for current running phases', () => {
    expect(
      formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
        style: 'cli',
        substate: STREAM_SUBSTATE.RESUMING,
      }),
    ).toBe('resuming');
    expect(
      streamStatusDisplayKey(STREAM_PHASE.RUNNING, STREAM_SUBSTATE.STARTING),
    ).toBe(STREAM_SUBSTATE.STARTING);
    expect(
      streamStatusIndicatorClass(
        STREAM_PHASE.RUNNING,
        STREAM_SUBSTATE.RESUMING,
      ),
    ).toBe('is-resuming');
  });

  it.each([
    [STREAM_PHASE.RUNNING, STREAM_PHASE.RUNNING, 'is-running'],
    [STREAM_PHASE.COMPLETED, STREAM_PHASE.COMPLETED, 'is-completed'],
    [STREAM_PHASE.CANCELLED, STREAM_PHASE.CANCELLED, 'is-cancelled'],
    [STREAM_PHASE.FAILED, STREAM_PHASE.FAILED, 'is-failed'],
    [STREAM_PHASE.WAITING, STREAM_PHASE.WAITING, 'is-waiting'],
    [STREAM_STATUS.READY, 'ready', 'is-ready'],
  ] as const)(
    'maps lifecycle status %s to display key %s and class %s',
    (status, key, className) => {
      expect(streamStatusDisplayKey(status)).toBe(key);
      expect(streamStatusIndicatorClass(status)).toBe(className);
    },
  );
});
