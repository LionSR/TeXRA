// Suites for src/shared/streams (child-activity reducer, stream metadata,
// status display, stream-meta reducer).

import { describe, expect, it } from 'vitest';
import {
  type ActiveChildInfo,
  AgentCategory,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
} from '@shared/schemas';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
  streamStatusDisplayKey,
  streamStatusIndicatorClass,
  type StreamStatusLabelStyle,
} from '@shared/streams/streamStatusDisplay';
import {
  EMPTY_STREAM_META,
  reduceStreamMeta,
  type StreamMeta,
} from '@shared/streams/streamMetaReducer';

// ---------------------------------------------------------------------------
// ChildActivityReducer
// ---------------------------------------------------------------------------

interface Child {
  readonly executionId: string;
}

function child(executionId: string): Child {
  return { executionId };
}

describe('diffActiveChildren', () => {
  it('reports no vanished ids when previous is empty', () => {
    const vanishedIds = diffActiveChildren([], [child('a')]);

    expect(vanishedIds.size).toBe(0);
  });

  it('reports all previous ids as vanished when next is empty', () => {
    const vanishedIds = diffActiveChildren([child('a'), child('b')], []);

    expect(vanishedIds).toEqual(new Set(['a', 'b']));
  });

  it('reports only the ids that dropped out on partial overlap', () => {
    const vanishedIds = diffActiveChildren(
      [child('a'), child('b'), child('c')],
      [child('b'), child('c'), child('d')],
    );

    expect(vanishedIds).toEqual(new Set(['a']));
  });

  it('is unaffected by duplicate ids in either input', () => {
    const vanishedIds = diffActiveChildren(
      [child('a'), child('a'), child('b')],
      [child('a')],
    );

    expect(vanishedIds).toEqual(new Set(['b']));
  });

  it('reports nothing vanished when previous and next are identical', () => {
    const vanishedIds = diffActiveChildren(
      [child('a'), child('b')],
      [child('a'), child('b')],
    );

    expect(vanishedIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// StreamMetadata
// ---------------------------------------------------------------------------

describe('buildStreamMetadata', () => {
  it('fills backend-owned defaults for a stream state metadata payload', () => {
    const metadata = buildStreamMetadata({ kind: AgentCategory.Workflow });

    expect(metadata).toMatchObject({
      kind: AgentCategory.Workflow,
      status: STREAM_STATUS.READY,
      conversationProgress: { toolCallCount: 0 },
      roundStage: null,
      activeSubagents: [],
      finishedSubagentCount: 0,
      activeProcesses: [],
      finishedProcessCount: 0,
    });
    expect(Object.hasOwn(metadata, 'substate')).toBe(true);
    expect(metadata.substate).toBeUndefined();
  });

  it('preserves supplied status, progress, child badges, and timestamps', () => {
    const child: ActiveChildInfo = {
      kind: 'process',
      executionId: 'agent-1',
      agentName: 'review',
      status: STREAM_STATUS.RUNNING,
    };

    expect(
      buildStreamMetadata({
        kind: AgentCategory.ToolUse,
        status: STREAM_STATUS.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
        lastTimestamp: 123,
        conversationProgress: { toolCallCount: 5 },
        roundStage: { index: 1, total: 3 },
        activeSubagents: [child],
        finishedSubagentCount: 1,
        activeProcesses: [child],
        finishedProcessCount: 3,
      }),
    ).toEqual({
      kind: AgentCategory.ToolUse,
      status: STREAM_STATUS.RUNNING,
      substate: STREAM_SUBSTATE.STARTING,
      lastTimestamp: 123,
      conversationProgress: { toolCallCount: 5 },
      roundStage: { index: 1, total: 3 },
      activeSubagents: [child],
      finishedSubagentCount: 1,
      activeProcesses: [child],
      finishedProcessCount: 3,
    });
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

describe('stream status display labels', () => {
  const wordingCases: Array<[StreamStatusLabelStyle, string, string]> = [
    ['cli', STREAM_STATUS.INITIALIZING, 'starting\u2026'],
    ['cli', STREAM_STATUS.WAITING, 'idle'],
    ['cliCompact', STREAM_STATUS.INITIALIZING, 'starting'],
    ['cliCompact', STREAM_STATUS.WAITING, 'idle'],
    ['progressHeader', STREAM_STATUS.WAITING, 'Waiting for follow-up'],
    ['progressHeader', STREAM_STATUS.INITIALIZING, 'Initializing'],
    ['cliCompact', STREAM_PHASE.COMPLETED, 'completed'],
    ['progressHeader', STREAM_PHASE.COMPLETED, 'Completed'],
    ['cliCompact', STREAM_STATUS.STOPPED, 'stopped'],
  ];

  it.each(wordingCases)(
    'preserves %s wording: %s -> "%s"',
    (style, status, label) => {
      expect(formatStreamStatusLabel(status, { style })).toBe(label);
    },
  );

  it.each(['cli', 'cliCompact'] as const)(
    'labels a child stream WAITING distinctly from the root idle wording (%s)',
    (style) => {
      expect(
        formatStreamStatusLabel(STREAM_STATUS.WAITING, {
          style,
          isChildStream: true,
        }),
      ).toBe('waiting for you');
      // Unset (or false) isChildStream keeps the root's plain "idle" wording.
      expect(formatStreamStatusLabel(STREAM_STATUS.WAITING, { style })).toBe(
        'idle',
      );
      expect(
        formatStreamStatusLabel(STREAM_STATUS.WAITING, {
          style,
          isChildStream: false,
        }),
      ).toBe('idle');
    },
  );

  it('ignores isChildStream for the progressHeader style, which already says "Waiting for follow-up"', () => {
    expect(
      formatStreamStatusLabel(STREAM_STATUS.WAITING, {
        style: 'progressHeader',
        isChildStream: true,
      }),
    ).toBe('Waiting for follow-up');
  });

  it('ignores isChildStream for statuses other than WAITING', () => {
    expect(
      formatStreamStatusLabel(STREAM_PHASE.COMPLETED, {
        style: 'cli',
        isChildStream: true,
      }),
    ).toBe('completed');
  });

  it('passes through unknown statuses and supports an explicit missing label', () => {
    expect(formatStreamStatusLabel('custom')).toBe('custom');
    expect(formatStreamStatusLabel('')).toBe('');
    expect(formatStreamStatusLabel(undefined, { missingLabel: '-' })).toBe('-');
  });

  it('uses substate display keys for current running phases', () => {
    expect(
      formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
        style: 'progressHeader',
        substate: STREAM_SUBSTATE.STARTING,
      }),
    ).toBe('Initializing');
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
    [STREAM_STATUS.INITIALIZING, STREAM_SUBSTATE.STARTING, 'is-starting'],
    [STREAM_STATUS.RESUMING, STREAM_SUBSTATE.RESUMING, 'is-resuming'],
    [STREAM_STATUS.STOPPED, STREAM_PHASE.COMPLETED, 'is-completed'],
    [STREAM_STATUS.ERROR, STREAM_PHASE.FAILED, 'is-failed'],
    [STREAM_STATUS.WAITING, STREAM_PHASE.WAITING, 'is-waiting'],
    [STREAM_STATUS.READY, 'ready', 'is-ready'],
  ] as const)(
    'maps legacy %s to display key %s and class %s',
    (status, key, className) => {
      expect(streamStatusDisplayKey(status)).toBe(key);
      expect(streamStatusIndicatorClass(status)).toBe(className);
    },
  );
});

// ---------------------------------------------------------------------------
// StreamMetaReducer
// ---------------------------------------------------------------------------

const OPTS = { outputCap: { maxChars: 100 } } as const;

function meta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return { ...EMPTY_STREAM_META, ...overrides };
}

describe('reduceStreamMeta', () => {
  describe('processOutput cap policies', () => {
    it('exact head-cut at the cap when retainChars is omitted (CLI policy)', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '0123456789', stderr: '' }]]),
      });
      // combined = "0123456789abc" (13) > 5 → keep last 5 → "89abc".
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'abc', stderr: '' },
        { outputCap: { maxChars: 5 } },
      );
      expect(next.processOutput.get('e')).toEqual({
        stdout: '89abc',
        stderr: '',
      });
    });

    it('trims to retainChars once maxChars is crossed (webview 100k→80k policy)', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '0123456789', stderr: '' }]]),
      });
      // combined length 13 > 10 → keep last 5 → "89abc".
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'abc', stderr: '' },
        { outputCap: { maxChars: 10, retainChars: 5 } },
      );
      expect(next.processOutput.get('e')?.stdout).toBe('89abc');
    });

    it('clamps retainChars to maxChars', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '0123456789', stderr: '' }]]),
      });
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'abc', stderr: '' },
        { outputCap: { maxChars: 5, retainChars: 100 } },
      );
      expect(next.processOutput.get('e')?.stdout).toBe('89abc');
    });

    it('keeps appending up to maxChars before the next reset', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '012345', stderr: '' }]]),
      });
      // combined "012345ab" (8) <= 10 → plain append, no reset yet.
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'ab', stderr: '' },
        { outputCap: { maxChars: 10, retainChars: 5 } },
      );
      expect(next.processOutput.get('e')?.stdout).toBe('012345ab');
    });

    it('seeds a missing execution entry from empty', () => {
      const next = reduceStreamMeta(
        meta(),
        {
          kind: 'processOutput',
          executionId: 'new',
          stdout: 'hi',
          stderr: 'e',
        },
        OPTS,
      );
      expect(next.processOutput.get('new')).toEqual({
        stdout: 'hi',
        stderr: 'e',
      });
    });
  });

  describe('activeProcesses', () => {
    const active: ActiveChildInfo = {
      kind: 'process',
      executionId: 'active',
      agentName: 'bash',
    };

    it('sets the active list and prunes output for vanished processes', () => {
      const base = meta({
        activeProcesses: [],
        processOutput: new Map([
          ['active', { stdout: 'a', stderr: '' }],
          ['stale', { stdout: 's', stderr: '' }],
        ]),
      });
      const next = reduceStreamMeta(
        base,
        { kind: 'activeProcesses', processes: [active] },
        OPTS,
      );
      expect(next.activeProcesses).toEqual([active]);
      expect(next.processOutput.has('active')).toBe(true);
      expect(next.processOutput.has('stale')).toBe(false);
      // Input is untouched.
      expect(base.processOutput.has('stale')).toBe(true);
    });

    it('keeps the same output-map identity when nothing is pruned', () => {
      const output = new Map([['active', { stdout: 'a', stderr: '' }]]);
      const base = meta({ processOutput: output });
      const next = reduceStreamMeta(
        base,
        { kind: 'activeProcesses', processes: [active] },
        OPTS,
      );
      expect(next.processOutput).toBe(output);
    });
  });

  describe('purity', () => {
    it('returns a fresh meta and map without mutating the input', () => {
      const output = new Map([['e', { stdout: 'x', stderr: '' }]]);
      const base = meta({ processOutput: output });
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'y', stderr: '' },
        OPTS,
      );
      expect(next).not.toBe(base);
      expect(next.processOutput).not.toBe(output);
      expect(output.get('e')).toEqual({ stdout: 'x', stderr: '' });
    });
  });
});
