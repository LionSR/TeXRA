// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  LIVE_TAIL_ROWS,
  boundedTranscriptEntryLayout,
  fullTranscriptEntryLayout,
  liveAssistantDisplayLines,
  transcriptEntryLayout,
  transcriptEntryLayoutRows,
} from '@cli/chat/tui/panes/transcriptEntryLayout';
import { formatRenderError } from '@cli/chat/tui/panes/EntryErrorBoundary';
import {
  incrementalStaticTranscriptEntries,
  isInquiryContinuationText,
  orderedStaticTranscriptEntries,
  splitTranscriptEntries,
  terminalVisibleTranscriptText,
  trimAssistantTranscriptLead,
} from '@cli/chat/tui/panes/transcriptEntries';
import { hydratedTranscript } from '@cli/chat/tui/panes/TranscriptReader';
import {
  advanceStaticTranscriptState,
  buildStaticTranscriptItems,
  buildStaticTranscriptState,
  DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  sessionHeaderIdentityLine,
  trimStaticTranscriptItems,
  type StaticTranscriptItem,
  type StaticTranscriptRingBudgets,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import { staticScrollbackTarget } from '@cli/chat/tui/appLayout';
import { staticTranscriptRepaintEpoch } from '@cli/chat/tui/state/staticTranscriptRepaint';
import { transcriptViewportKey } from '@cli/chat/tui/state/transcriptViewportMode';
import {
  createTuiViewportController,
  type TuiRepaintOptions,
} from '@cli/chat/tui/render/tuiViewportController';
import { textDisplayWidth } from '@cli/runtime/terminalText';
import {
  estimateLiveTranscriptEntryRows,
  estimateTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from '@cli/chat/tui/panes/transcriptViewport';
import {
  emptySlice,
  resetCliState,
  patchStream,
  streams,
  type StreamSlice,
  setStreamStatusInCliState,
} from '@cli/chat/tui/state/cliState';
import {
  bindChildStreamState,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { transcriptToLines } from '@cli/chat/tui/state/transcriptLines';
import { CLI_LOCAL_STREAM_ID } from '@cli/chat/tui/state/transcript';
import { attachSessionSignalsAdapter } from '@cli/chat/tui/state/sessionSignalsAdapter';
import {
  isFinalizedTranscriptRow,
  transcriptRowHeadline,
} from '@cli/chat/tui/panes/transcriptEntries';
import { SessionState } from '@controllers/session/SessionState';
import {
  AgentCategory,
  RUN_OUTCOME,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type NormalizedToolUse,
  type RunOutcome,
  type StreamPhase,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  transcriptText,
  type ToolRow,
  type TranscriptRow,
} from '@shared/transcript';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';
import { buildChildRosters } from '@test/support/childRosters';
import {
  compactionRowFixture,
  textRowFixture,
  toolRowFixture,
} from '@test/support/transcriptRowFixtures';

const STREAM_ID = 'cli-test-stream' as StreamTabId;
const ROOT_STREAM = 'root-stream' as StreamTabId;
const CHILD_STREAM = 'claude@agent-sdk#1' as StreamTabId;
const SESSION_META = {
  agent: 'research',
  category: AgentCategory.ToolUse,
  model: 'deepseekT',
  modelSource: 'builtin-default',
  cwd: '/tmp/project',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  canDelegate: false,
  transcriptMode: 'persistent',
  version: '0.38.0',
} as const;

// A row the CLI treats as settled on arrival carries the recorder's durable
// settlement order. Fixtures settle in the order they were built, so a row's
// own wire position doubles as its settlement position.
function settled<T extends TranscriptRow>(row: T): T {
  return { ...row, settlementSeqNo: row.seqNo ?? 0 };
}

// Fixtures are built in the order they appear in the transcript, so a shared
// counter gives every row a wire position and lets a settled row state a
// settlement order that agrees with it.
let fixtureSeq = 0;

function entry(
  id: string,
  kind: 'assistant' | 'error' | 'user',
  text: string,
  isSettled: boolean,
): TranscriptRow {
  const seqNo = (fixtureSeq += 1);
  const row = { ...textRowFixture(id, kind, text), seqNo };
  // user/error rows settle on their own kind; only prose needs a settlement
  // order to count as printable.
  return isSettled && kind === 'assistant' ? settled(row) : row;
}

function compactionEntry(
  status: 'running' | 'interrupted' | 'completed',
  finalized = status === 'completed',
): TranscriptRow {
  return compactionRowFixture(status, finalized);
}

function toolEntry(
  id: string,
  status: NormalizedToolUse['status'],
  outputText = status === 'completed' ? 'ok' : '',
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  return {
    ...toolRowFixture(id, {
      toolName: 'Bash',
      outputText,
      input: { command: 'ls' },
      status,
      ...overrides,
    }),
    seqNo: (fixtureSeq += 1),
  };
}

function compactExecutionsEntry(id: string, path: string): ToolRow {
  return toolRowFixture(id, { toolName: 'executions', input: { path } }, 0);
}

function phaseRow(
  id: string,
  phaseLabel: string,
  phaseIndex?: number,
  phaseTotal?: number,
): TranscriptRow {
  return {
    kind: 'phase',
    id,
    timestamp: 0,
    level: 'info',
    heading: formatWorkflowPhaseHeading({ phaseLabel, phaseIndex, phaseTotal }),
    phaseLabel,
    ...(phaseIndex !== undefined ? { phaseIndex } : {}),
    ...(phaseTotal !== undefined ? { phaseTotal } : {}),
  };
}

function workflowTaskRow(
  id: string,
  call: WorkflowCallProgress,
  line = 'Planned: Task',
): TranscriptRow {
  return {
    kind: 'workflowTask',
    id,
    timestamp: 0,
    level: 'info',
    call,
    line,
    statusLabel: call.status,
    metadataParts: [],
  };
}

/** Split the rows a stream slice currently holds, at its own promotion cursor. */
function splitSliceEntries(
  streamId: StreamTabId,
  status: StreamPhase | undefined,
) {
  const slice = streams.get().get(streamId);
  return splitTranscriptEntries(
    slice?.entries ?? [],
    slice?.finalizedFrontier ?? 0,
    status,
  );
}

describe('CLI conversation transcript', () => {
  it('keeps only explicit finalized entries in scrollback', () => {
    const user = entry('u1', 'user', '1+1', true);
    const assistant = entry('a1', 'assistant', '2', false);

    const running = splitTranscriptEntries(
      [user, assistant],
      0,
      STREAM_PHASE.RUNNING,
    );
    expect(running.finalized).toEqual([user]);
    expect(running.pending).toEqual([assistant]);

    const waitingBeforeFinalize = splitTranscriptEntries(
      [user, assistant],
      0,
      STREAM_PHASE.WAITING,
    );
    expect(waitingBeforeFinalize.finalized).toEqual([user]);
    expect(waitingBeforeFinalize.pending).toEqual([]);
  });

  it('keeps finalized rows behind an unfinished assistant live in the pending pane', () => {
    const user = entry('u1', 'user', 'go', true);
    const assistant = entry('a1', 'assistant', 'working', false);
    const tool = {
      ...toolEntry('t1', TOOL_USE_STATUS.COMPLETED),
      finalized: true,
    };

    const split = splitTranscriptEntries(
      [user, assistant, tool],
      0,
      STREAM_PHASE.RUNNING,
    );
    expect(split.finalized.map((item) => item.id)).toEqual(['u1']);
    expect(split.pending.map((item) => item.id)).toEqual(['a1', 't1']);
  });

  it('keeps finalized rows behind unfinished tool and workflow rows live', () => {
    const tool = toolEntry('t1', 'in_progress');
    const toolPhase = phaseRow('p1', 'After tool');
    const workflowTask = workflowTaskRow('w1', {
      id: 'w1',
      label: 'Task',
      status: 'planned',
    });
    const workflowPhase = phaseRow('p2', 'After workflow task');

    const toolSplit = splitTranscriptEntries(
      [tool, toolPhase],
      0,
      STREAM_PHASE.RUNNING,
    );
    expect(toolSplit.finalized).toEqual([]);
    expect(toolSplit.pending.map((item) => item.id)).toEqual(['t1', 'p1']);

    const workflowSplit = splitTranscriptEntries(
      [workflowTask, workflowPhase],
      0,
      STREAM_PHASE.RUNNING,
    );
    expect(workflowSplit.finalized).toEqual([]);
    expect(workflowSplit.pending.map((item) => item.id)).toEqual(['w1', 'p2']);
  });

  it('keeps running compaction live and promotes its terminal update once', () => {
    const running = compactionEntry('running');
    expect(
      splitTranscriptEntries([running], 0, STREAM_PHASE.RUNNING).pending,
    ).toEqual([running]);
    expect(staticItemIds([running])).toEqual(['session-header']);

    const completed = compactionEntry('completed');
    expect(
      splitTranscriptEntries([completed], 0, STREAM_PHASE.RUNNING).finalized,
    ).toEqual([completed]);
    expect(staticItemIds([completed])).toEqual([
      'session-header',
      'compaction:operation-1',
    ]);
    expect(
      staticItemIds([completed], {
        currentItems: staticItems([completed]),
      }),
    ).toEqual(['session-header', 'compaction:operation-1']);
  });

  it('holds later rows out of Static until interrupted compaction is final', () => {
    const interrupted = compactionEntry('interrupted');
    const laterUser = entry('u1', 'user', 'Continue', true);
    const liveItems = staticItems([interrupted, laterUser]);

    expect(liveItems.map((item) => item.id)).toEqual(['session-header']);
    expect(
      splitTranscriptEntries([interrupted, laterUser], 0, STREAM_PHASE.RUNNING)
        .pending,
    ).toEqual([interrupted, laterUser]);

    const finalItems = staticItems([compactionEntry('completed'), laterUser], {
      currentItems: liveItems,
    });
    expect(finalItems.map((item) => item.id)).toEqual([
      'session-header',
      'compaction:operation-1',
      'u1',
    ]);
  });

  it('wraps compaction activity within a narrow viewport', () => {
    const layout = transcriptEntryLayout(compactionEntry('completed'), {
      width: 8,
    });

    expect(layout.kind).toBe('compactionActivity');
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.every((line) => textDisplayWidth(line) <= 8)).toBe(
      true,
    );
  });

  it('freezes assistant entries before they enter static scrollback', () => {
    resetCliState();
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [
        entry('u1', 'user', 'What is a tensor network?', true),
        entry('a1', 'assistant', 'A structured decomposition.', false),
      ],
    }));

    syncStreamLog(defaultSession(), STREAM_ID, { forceFinal: true });

    expect(streams.get().get(STREAM_ID)?.finalizedFrontier).toBe(2);
    const split = splitSliceEntries(STREAM_ID, STREAM_PHASE.WAITING);
    expect(split.finalized.map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(split.pending).toEqual([]);
  });

  // Status facts reach the CLI through the session-signals adapter: the
  // status machine publishes on the session hub, and the adapter's status
  // modality patches the slice before syncing the log (forceFinal on
  // settlement phases).
  function attachStatusPipeline(): () => void {
    const session = defaultSession();
    return attachSessionSignalsAdapter({
      events: session.events,
      session,
      snapshots: session.snapshots,
    });
  }

  it.each(Object.values(RUN_OUTCOME) as RunOutcome[])(
    'freezes assistant entries on the %s outcome',
    (outcome) => {
      // Per-outcome stream id: the shared session's log store must not know
      // the stream, or the forced final sync folds the (empty) store over
      // the slice-seeded fixture entries.
      const streamId = `${STREAM_ID}-${outcome}`;
      defaultSession().status.clearStream(streamId);
      resetCliState();
      patchStream(streamId, (slice) => ({
        ...slice,
        entries: [entry('a1', 'assistant', 'A final answer.', false)],
      }));
      const dispose = attachStatusPipeline();

      try {
        defaultSession().status.transition(streamId, outcome, 'restart-repair');

        const slice = streams.get().get(streamId);
        expect(slice?.entries.map((item) => item.id)).toEqual(['a1']);
        expect(slice?.finalizedFrontier).toBe(1);
      } finally {
        dispose();
        defaultSession().status.clearStream(streamId);
      }
    },
  );

  // Regression: a stream reused for a new run still carries WAITING from
  // the prior turn. The status must flip to a non-final value before
  // syncStreamLog derives finalizeDeferred, otherwise the next run's
  // in-flight entries get finalized early and lose later chunks.
  it('clears a stale final status before the next run streams', () => {
    // Twice: the first reset retires STREAM_ID from the previous test, and a
    // retired identity cannot take a status.
    resetCliState();
    resetCliState();
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.WAITING,
    });
    const dispose = attachStatusPipeline();

    try {
      defaultSession().status.transition(
        STREAM_ID,
        STREAM_PHASE.RUNNING,
        'resume',
      );

      expect(streams.get().get(STREAM_ID)?.status).toBe(STREAM_PHASE.RUNNING);
    } finally {
      dispose();
    }
  });

  // One pending bucket in stream order: a model that emits prose before a
  // tool call must render as assistant text then tool row, not the reverse.
  it('keeps pending entries in stream order so tool rows trail prior text', () => {
    const user = entry('u1', 'user', 'do a thing', true);
    const assistant = entry('a1', 'assistant', 'sure, running…', false);
    const tool = toolEntry('t1', 'in_progress');

    const split = splitTranscriptEntries(
      [user, assistant, tool],
      0,
      STREAM_PHASE.RUNNING,
    );

    expect(split.finalized.map((e) => e.id)).toEqual(['u1']);
    expect(split.pending.map((e) => e.id)).toEqual(['a1', 't1']);
  });

  // Regression: tool rows must not finalize on their own — the stream-
  // level finalizer is the single promotion edge. Otherwise a fast tool
  // call jumps into <Static> ahead of still-streaming assistant text
  // and the scrollback order ends up reversed.
  it('defers tool finalization to the stream-level finalize step', () => {
    const streamId = `${STREAM_ID}-defer-finalize`;
    resetCliState();
    patchStream(streamId, (slice) => ({
      ...slice,
      entries: [
        entry('a1', 'assistant', 'about to run a tool', false),
        toolEntry('t1', 'completed'),
      ],
    }));

    let split = splitSliceEntries(streamId, STREAM_PHASE.RUNNING);
    expect(split.finalized).toHaveLength(0);
    expect(split.pending.map((e) => e.id)).toEqual(['a1', 't1']);

    syncStreamLog(defaultSession(), streamId, { forceFinal: true });

    split = splitSliceEntries(streamId, STREAM_PHASE.WAITING);
    expect(split.finalized.map((e) => e.id)).toEqual(['a1', 't1']);
    expect(split.pending).toHaveLength(0);
  });

  it('keeps a bounded tail when the newest live entry is taller than the viewport', () => {
    const assistant = entry(
      'a1',
      'assistant',
      Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
      false,
    );

    const selected = selectTranscriptEntriesForViewport([assistant], 4, 80);

    expect(selected.entries.map((item) => item.id)).toEqual(['a1']);
    expect(selected.usedRows).toBe(4);
    expect(selected.rowLimits.get('a1')).toBe(4);
  });

  it('falls back when a malformed tool entry cannot be estimated', () => {
    const base = toolEntry('tool', TOOL_USE_STATUS.IN_PROGRESS);
    const malformedTool = {
      ...base.toolUse,
      toolName: {} as string,
    } as NormalizedToolUse;
    const malformedEntry: ToolRow = {
      ...base,
      toolUse: malformedTool,
    };

    expect(estimateTranscriptEntryRows(malformedEntry, 80)).toBe(1);

    const selected = selectTranscriptEntriesForViewport(
      [malformedEntry],
      3,
      80,
    );
    expect(selected.entries.map((item) => item.id)).toEqual(['tool']);
    expect(selected.usedRows).toBe(1);
    expect(selected.rowLimits.has('tool')).toBe(false);
  });

  it('formats unprintable render errors without throwing', () => {
    const unprintable = {
      toString() {
        throw new Error('cannot stringify');
      },
    };

    expect(formatRenderError(unprintable)).toBe('');
  });

  it('renders bounded finalized assistant tails through markdown', () => {
    const text = ['intro line', 'middle line', '**bold tail marker**'].join(
      '\n',
    );

    const assistant = (isSettled: boolean): TranscriptRow =>
      entry(
        isSettled ? 'finalized' : 'streaming',
        'assistant',
        text,
        isSettled,
      );
    const finalizedTail = boundedTranscriptEntryLayout(
      transcriptEntryLayout(assistant(true), {
        colorEnabled: false,
        mode: 'bounded',
        width: 80,
      }),
      1,
    ).lines.join('\n');
    const streamingTail = boundedTranscriptEntryLayout(
      transcriptEntryLayout(assistant(false), {
        colorEnabled: false,
        mode: 'bounded',
        width: 80,
      }),
      1,
    ).lines.join('\n');

    expect(finalizedTail).toContain('bold tail marker');
    expect(finalizedTail).not.toContain('**bold tail marker**');
    expect(streamingTail).toContain('**bold tail marker**');

    const cappedStreamingTail = boundedTranscriptEntryLayout(
      transcriptEntryLayout(entry('tail', 'assistant', 'x'.repeat(25), false), {
        maxRows: 1,
        mode: 'bounded',
        width: 10,
      }),
      1,
    );
    expect(cappedStreamingTail.lines).toEqual(['x'.repeat(10)]);
  });

  it('budgets live assistant display-math rows with the live renderer', () => {
    const text = [
      'The sum evaluates to 1.6449290668357264.',
      'For reference, the exact value is',
      '\\[',
      '  \\frac{\\pi^2}{6} \\approx 1.6449340668482264',
      '\\]',
      'So the partial sum up to $n = 199,\\!999$ is only off by about $5 \\times 10^{-6}$.',
    ].join('\n');
    const assistant = entry('a1', 'assistant', text, false);
    const width = 52;
    const liveRows = liveAssistantDisplayLines({
      rows: LIVE_TAIL_ROWS,
      text,
      width,
    }).length;

    const selected = selectTranscriptEntriesForViewport(
      [assistant],
      100,
      width,
    );

    expect(estimateLiveTranscriptEntryRows(assistant, width)).toBe(liveRows);
    expect(selected.usedRows).toBe(liveRows);
    expect(selected.rowLimits.has('a1')).toBe(false);
  });

  it('derives insets, margins, prefixed lines, and row counts from one layout', () => {
    const user = entry('u1', 'user', 'x'.repeat(77), true);
    const userLayout = transcriptEntryLayout(user, { width: 80 });
    expect(userLayout).toMatchObject({
      columns: 78,
      inset: 2,
      marginBottomRows: 1,
      marginTopRows: 1,
    });
    // Row prefixes are baked into the lines, not advertised as layout fields.
    expect(userLayout.lines[0]?.startsWith('› ')).toBe(true);
    expect(userLayout.lines[1]?.startsWith('  ')).toBe(true);
    expect(userLayout.lines).toHaveLength(2);
    expect(transcriptEntryLayoutRows(userLayout)).toBe(4);
    expect(estimateTranscriptEntryRows(user, 80)).toBe(
      transcriptEntryLayoutRows(userLayout),
    );

    const tool = toolEntry('t1', TOOL_USE_STATUS.COMPLETED, 'one\ntwo');
    const toolLayout = transcriptEntryLayout(tool, { width: 80 });
    expect(toolLayout).toMatchObject({
      columns: 80,
      inset: 0,
      marginBottomRows: 1,
      marginTopRows: 0,
    });
    expect(estimateTranscriptEntryRows(tool, 80)).toBe(
      transcriptEntryLayoutRows(toolLayout),
    );
  });

  it('gives every workflow-call status its own steady marker', () => {
    const calls: readonly WorkflowCallProgress[] = [
      { id: 'a', label: 'Task', status: 'planned' },
      { id: 'a', label: 'Task', status: 'running' },
      { id: 'a', label: 'Task', status: 'completed' },
      { id: 'a', label: 'Task', status: 'cached' },
      { id: 'a', label: 'Task', status: 'skipped', reason: 'user' },
      { id: 'a', label: 'Task', status: 'failed', error: 'Runner stopped.' },
    ];
    const firstLines = calls.map(
      (call) =>
        transcriptEntryLayout(workflowTaskRow('a', call, 'Task'), {
          width: 80,
        }).lines[0] ?? '',
    );

    // Every call row nests two columns under the `◆` phase divider heading it.
    expect(firstLines.every((line) => line.startsWith('  '))).toBe(true);
    expect(firstLines.map((line) => line.slice(2, 4))).toEqual([
      '□ ',
      '☐ ',
      '☑ ',
      '✓ ',
      '⊘ ',
      '✗ ',
    ]);
  });

  it('aligns a wrapped call row under its own marker', () => {
    const layout = transcriptEntryLayout(
      workflowTaskRow(
        'a',
        { id: 'a', label: 'Task', status: 'completed', durationMs: 1 },
        `Finished: ${'w'.repeat(40)} ${'x'.repeat(40)}`,
      ),
      { width: 40 },
    );

    expect(layout.lines[0]?.startsWith('  ☑ ')).toBe(true);
    expect(layout.lines.slice(1).every((line) => line.startsWith('    '))).toBe(
      true,
    );
    expect(layout.lines.length).toBeGreaterThan(1);
  });

  it('budgets live rich tool rows without reflowing their display lines', () => {
    const tool = toolEntry('t1', TOOL_USE_STATUS.COMPLETED, 'ok', {
      input: { command: 'x'.repeat(80) },
    });
    const liveLayout = transcriptEntryLayout(tool, {
      mode: 'live',
      width: 20,
    });

    expect(liveLayout.lines).toHaveLength(2);
    expect(estimateTranscriptEntryRows(tool, 20)).toBeGreaterThan(
      estimateLiveTranscriptEntryRows(tool, 20),
    );
    expect(selectTranscriptEntriesForViewport([tool], 20, 20).usedRows).toBe(
      transcriptEntryLayoutRows(liveLayout),
    );
  });

  it('keeps bounded rich display rows unwrapped', () => {
    const tool = toolEntry('t1', TOOL_USE_STATUS.COMPLETED, 'x'.repeat(40));
    const live = transcriptEntryLayout(tool, { mode: 'live', width: 20 });
    const bounded = boundedTranscriptEntryLayout(
      transcriptEntryLayout(tool, { mode: 'bounded', width: 20 }),
      10,
    );

    expect(bounded.lines).toEqual(live.lines);
  });

  it('budgets live user prompt bands with their margin rows', () => {
    const user = entry('u1', 'user', 'why do you write as a latex?', true);

    expect(estimateTranscriptEntryRows(user, 80)).toBe(3);
  });

  it('does not render empty assistant placeholders between user and tool rows', () => {
    const user = entry('u1', 'user', 'what is this repo about', true);
    const emptyAssistant = entry('a1', 'assistant', '\n  \n', false);
    const tool = toolEntry('t1', 'in_progress');

    const split = splitTranscriptEntries(
      [user, emptyAssistant, tool],
      0,
      STREAM_PHASE.RUNNING,
    );
    expect(split.finalized.map((item) => item.id)).toEqual(['u1']);
    expect(split.pending.map((item) => item.id)).toEqual(['t1']);

    expect(
      selectTranscriptEntriesForViewport(
        [emptyAssistant, tool],
        4,
        80,
      ).entries.map((item) => item.id),
    ).toEqual(['t1']);

    expect(
      staticItemIds([user, settled(emptyAssistant), settled(tool)]),
    ).toEqual(['session-header', 'u1', 't1']);

    expect(
      transcriptToLines(
        sliceWithEntries(STREAM_ID, [user, emptyAssistant, tool]),
        80,
      ),
    ).toEqual(['› what is this repo about', '● Bash (ls)']);
  });

  it('keeps a live prompt out of static scrollback until a continuation exists', () => {
    const user = entry('u1', 'user', 'what is this repo about', true);
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        STREAM_ID,
        sliceWithEntries(STREAM_ID, [user], {
          status: STREAM_PHASE.RUNNING,
        }),
      ],
    ]);

    const split = splitTranscriptEntries([user], 0, STREAM_PHASE.RUNNING);
    expect(split.finalized).toEqual([]);
    expect(split.pending.map((item) => item.id)).toEqual(['u1']);

    const items = buildStaticTranscriptItems({
      scrollbackStreamId: STREAM_ID,
      currentItems: [],
      streams,
      meta: SESSION_META,
    }).items;
    expect(items.map((item) => item.id)).toEqual(['session-header']);
  });

  it('prints a deferred live prompt compactly once a tool continuation exists', () => {
    const user = entry('u1', 'user', 'what is this repo about', true);
    const tool = toolEntry('t1', 'in_progress');
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        STREAM_ID,
        sliceWithEntries(STREAM_ID, [user, tool], {
          status: STREAM_PHASE.RUNNING,
        }),
      ],
    ]);

    const split = splitTranscriptEntries([user, tool], 0, STREAM_PHASE.RUNNING);
    expect(split.finalized.map((item) => item.id)).toEqual(['u1']);
    expect(split.pending.map((item) => item.id)).toEqual(['t1']);

    const items = buildStaticTranscriptItems({
      scrollbackStreamId: STREAM_ID,
      currentItems: [],
      streams,
      meta: SESSION_META,
    }).items;
    expect(items.map((item) => item.id)).toEqual(['session-header', 'u1']);
    expect(items[1]).toMatchObject({ kind: 'entry' });
  });

  it('keeps inquiry continuations on the finalized transcript path', () => {
    const continuation = entry(
      'u1',
      'user',
      '[inquiry] ei_123 answered.\nQ: Can this be simplified?\nA: Yes.',
      true,
    );
    const assistant = entry('a1', 'assistant', 'working', false);

    const split = splitTranscriptEntries(
      [continuation, assistant],
      0,
      STREAM_PHASE.RUNNING,
    );
    expect(split.finalized.map((item) => item.id)).toEqual(['u1']);
    expect(split.pending.map((item) => item.id)).toEqual(['a1']);
  });

  it('does not reserve rows for zero-width assistant placeholders before tools', () => {
    const user = entry('u1', 'user', 'what is this repo about', true);
    const invisibleAssistant = entry(
      'a1',
      'assistant',
      '\u001B[2m\u001B[22m\u200B\n\n',
      false,
    );
    const tool = toolEntry('t1', 'in_progress');

    const invisibleText = transcriptRowHeadline(invisibleAssistant);
    expect(terminalVisibleTranscriptText(invisibleText)).toBe('');
    expect(trimAssistantTranscriptLead(invisibleText)).toBe('');
    expect(trimAssistantTranscriptLead('\u001B[2m\u200B\nvisible')).toBe(
      '\u001B[2mvisible',
    );
    expect(trimAssistantTranscriptLead('\n\u001B[31mvisible')).toBe(
      '\u001B[31mvisible',
    );
    expect(
      splitTranscriptEntries(
        [user, invisibleAssistant, tool],
        0,
        STREAM_PHASE.RUNNING,
      ).pending.map((item) => item.id),
    ).toEqual(['t1']);
    expect(
      transcriptToLines(
        sliceWithEntries(STREAM_ID, [user, invisibleAssistant, tool]),
        80,
      ),
    ).toEqual(['› what is this repo about', '● Bash (ls)']);
  });

  it('wraps live user rows at the padded width with user band margins', () => {
    const continuation = entry(
      'u1',
      'user',
      '[inquiry] ei_123 answered.\nQ: Can this be simplified?\nA: Yes.',
      true,
    );
    expect(estimateTranscriptEntryRows(continuation, 80)).toBe(3);

    // 77 chars exceeds the padded wrap width (80 - 4 = 76) by one, so the
    // row estimate must reflect the gutter + prefix geometry, not the
    // terminal width, and normal user prompts include the band margins.
    const long = entry('u2', 'user', 'x'.repeat(77), true);
    expect(estimateTranscriptEntryRows(long, 80)).toBe(4);
  });

  it('appends only finalized entries to terminal scrollback items', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', false);

    const first = staticItems([user, assistant]);
    expect(first).toHaveLength(2);
    expect(first[0]?.kind).toBe('header');
    expect(first.slice(1).map((item) => item.id)).toEqual(['u1']);

    const second = staticItems([user, settled(assistant)], {
      currentItems: first,
    });
    expect(second).toHaveLength(3);
    expect(second.slice(1).map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('shows the session header exactly once', () => {
    const first = buildStaticTranscriptItems({
      scrollbackStreamId: undefined,
      currentItems: [],
      streams: new Map(),
      meta: SESSION_META,
    }).items;
    expect(first).toHaveLength(1);

    const again = buildStaticTranscriptItems({
      scrollbackStreamId: undefined,
      currentItems: first,
      streams: new Map(),
      meta: { ...SESSION_META, model: 'sonnet' },
    }).items;
    expect(again).toHaveLength(1);
  });

  it('uses a compact header but preserves static transcript entries for short terminal layouts', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', true);

    const compact = staticItems([user, assistant], { maxRows: 2, width: 80 });

    expect(compact).toHaveLength(3);
    expect(compact[0]).toMatchObject({
      id: 'session-header',
      kind: 'header',
      compact: true,
    });
    expect(compact.slice(1).map((item) => item.id)).toEqual(['u1', 'a1']);

    expect(staticItemIds([user, assistant], { maxRows: 0, width: 80 })).toEqual(
      ['u1', 'a1'],
    );
  });

  it('inserts a newly eligible header before existing compact transcript entries', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', true);
    const compact = staticItems([user, assistant], { maxRows: 0, width: 80 });

    expect(
      staticItemIds([user, assistant], { currentItems: compact, width: 80 }),
    ).toEqual(['session-header', 'u1', 'a1']);
  });

  it('keeps full tool output as the conservative static-header budget', () => {
    const tool = {
      ...toolEntry(
        't1',
        TOOL_USE_STATUS.COMPLETED,
        Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'),
      ),
      settlementSeqNo: 0,
    } satisfies ToolRow;
    const renderedRows = transcriptEntryLayoutRows(
      transcriptEntryLayout(tool, { mode: 'scrollback', width: 80 }),
    );
    const budgetRows = transcriptEntryLayoutRows(
      transcriptEntryLayout(tool, {
        mode: 'scrollback-budget',
        width: 80,
      }),
    );
    expect(budgetRows).toBeGreaterThan(renderedRows);

    const withoutHeader = staticItems([tool], { maxRows: 0, width: 80 });
    expect(withoutHeader.map((item) => item.id)).toEqual(['t1']);
    expect(
      staticItemIds([tool], {
        currentItems: withoutHeader,
        maxRows: renderedRows + 4,
        width: 80,
      }),
    ).toEqual(['t1']);
  });

  it.each([
    {
      // One text row plus the band's top and bottom margin rows = 3; the full
      // header needs 4 more.
      name: 'user band margins',
      target: entry('u1', 'user', 'short prompt', true),
      budgetWithoutHeader: 6,
      budgetWithHeader: 7,
    },
    {
      // 77 chars wraps to two rows at the padded width (80 - 4 = 76);
      // the full header needs 4 more.
      name: 'static error rows at the padded wrap width',
      target: entry('e1', 'error', 'x'.repeat(77), true),
      budgetWithoutHeader: 5,
      budgetWithHeader: 6,
    },
    {
      // One text row and no margin rows; the full header needs 4 more.
      name: 'inquiry continuation without band margins',
      target: entry('u1', 'user', '[inquiry] ei_123 answered.', true),
      budgetWithoutHeader: 4,
      budgetWithHeader: 5,
    },
  ])(
    'budgets $name before inserting a compact static header',
    ({ target, budgetWithoutHeader, budgetWithHeader }) => {
      const compact = staticItems([target], { maxRows: 0, width: 80 });

      expect(compact.map((item) => item.id)).toEqual([target.id]);
      expect(
        staticItemIds([target], {
          currentItems: compact,
          maxRows: budgetWithoutHeader,
          width: 80,
        }),
      ).toEqual([target.id]);
      expect(
        staticItemIds([target], {
          currentItems: compact,
          maxRows: budgetWithHeader,
          width: 80,
        }),
      ).toEqual(['session-header', target.id]);
    },
  );

  it('preserves static transcript order when an entry exceeds the compact row budget', () => {
    const first = entry('u1', 'user', 'first', true);
    const large = entry('a1', 'assistant', 'line 1\nline 2\nline 3', true);
    const later = entry('u2', 'user', 'later', true);

    expect(
      staticItemIds([first, large, later], { maxRows: 2, width: 80 }),
    ).toEqual(['session-header', 'u1', 'a1', 'u2']);
  });

  it('bounds the static transcript ring by rows without trimming the header', () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(`e${index}`, 'assistant', 'x', true),
    );
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 12,
      rowLowWater: 8,
      byteHighWater: 1024 * 1024,
      byteLowWater: 1024 * 1024,
    };
    const built = buildStaticTranscriptItems({
      currentItems: [],
      streams: new Map([[STREAM_ID, sliceWithEntries(STREAM_ID, entries)]]),
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e16',
      'e17',
      'e18',
      'e19',
    ]);
    expect(built.rowCount).toBeLessThanOrEqual(budgets.rowLowWater);
  });

  it('bounds the static transcript ring by bytes and drops oldest non-header items', () => {
    const entries = Array.from({ length: 3 }, (_, index) =>
      entry(`e${index}`, 'assistant', 'x'.repeat(80), true),
    );
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 10_000,
      rowLowWater: 10_000,
      byteHighWater: 160,
      byteLowWater: 64,
    };
    const built = buildStaticTranscriptItems({
      currentItems: [],
      streams: new Map([[STREAM_ID, sliceWithEntries(STREAM_ID, entries)]]),
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e2',
    ]);
  });

  it('keeps a single oversized finalized entry even when it exceeds the budget', () => {
    const oversized = entry('e0', 'assistant', 'x'.repeat(80), true);
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 2,
      rowLowWater: 1,
      byteHighWater: 10,
      byteLowWater: 5,
    };
    const built = buildStaticTranscriptItems({
      currentItems: [],
      streams: new Map([[STREAM_ID, sliceWithEntries(STREAM_ID, [oversized])]]),
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e0',
    ]);
    expect(built.trimmed).toBe(false);
  });

  it('reports a trim when the newest oversized entry forces a prefix drop', () => {
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 1,
      rowLowWater: 1,
      byteHighWater: 1024 * 1024,
      byteLowWater: 1024 * 1024,
    };
    const built = buildStaticTranscriptItems({
      currentItems: [],
      streams: new Map([
        [
          STREAM_ID,
          sliceWithEntries(STREAM_ID, [
            entry('e0', 'assistant', 'first', true),
            entry('e1', 'assistant', 'second', true),
            entry('e2', 'assistant', 'x'.repeat(80), true),
          ]),
        ],
      ]),
      maxRows: 1,
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e2',
    ]);
    expect(built.trimmed).toBe(true);
  });

  it('trims a static tail with margin-collapse-aware row accounting', () => {
    const header: StaticTranscriptItem = {
      id: 'session-header',
      kind: 'header',
      compact: false,
      identityLine: 'agent: research · model: test',
      meta: SESSION_META,
    };
    const user1: StaticTranscriptItem = {
      id: 'u1',
      kind: 'entry',
      entry: entry('u1', 'user', 'first', true),
    };
    const user2: StaticTranscriptItem = {
      id: 'u2',
      kind: 'entry',
      entry: entry('u2', 'user', 'second', true),
    };
    const beforeRows =
      4 +
      transcriptEntryLayoutRows(
        transcriptEntryLayout(user1.entry, { width: 80 }),
      ) +
      transcriptEntryLayoutRows(
        transcriptEntryLayout(user2.entry, {
          previousEntry: user1.entry,
          width: 80,
        }),
      );
    const trimmed = trimStaticTranscriptItems([header, user1, user2], {
      budgets: {
        rowHighWater: beforeRows - 1,
        rowLowWater: beforeRows - 1,
        byteHighWater: Number.MAX_SAFE_INTEGER,
        byteLowWater: Number.MAX_SAFE_INTEGER,
      },
      totals: { rows: beforeRows, bytes: 0 },
      width: 80,
    });

    expect(trimmed.items.map((item) => item.id)).toEqual([
      'session-header',
      'u2',
    ]);
    expect(trimmed.totals.rows).toBeLessThanOrEqual(beforeRows);
  });

  it('keeps a finalized tool behind an unfinalized assistant out of the settled prefix', () => {
    const user = entry('u1', 'user', 'go', true);
    const assistant = entry('a1', 'assistant', 'working', false);
    const tool = {
      ...settled(toolEntry('t1', TOOL_USE_STATUS.COMPLETED)),
    };
    const settledAssistant = settled(assistant);
    const emptyCursor = {
      entriesRef: undefined,
      scannedIndex: 0,
      lastScannedEntry: undefined,
      status: undefined,
    } as const;

    expect(
      orderedStaticTranscriptEntries(
        [user, assistant, tool],
        0,
        STREAM_PHASE.RUNNING,
      ).map((item) => item.id),
    ).toEqual(['u1']);

    const first = incrementalStaticTranscriptEntries(
      [user, assistant, tool],
      0,
      STREAM_PHASE.RUNNING,
      emptyCursor,
    );
    expect(first.appended.map((item) => item.id)).toEqual(['u1']);
    expect(first.cursor.scannedIndex).toBe(1);

    const second = incrementalStaticTranscriptEntries(
      [user, settledAssistant, tool],
      0,
      STREAM_PHASE.RUNNING,
      first.cursor,
    );
    expect(second.appended.map((item) => item.id)).toEqual(['a1', 't1']);
    expect(second.cursor.scannedIndex).toBe(3);
  });

  it('rescans pending child entries when the child model identity arrives', () => {
    const CHILD = 'search-stream' as StreamTabId;
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [CHILD, ROOT_STREAM],
    ]);
    const childEntry = entry('a1', 'assistant', 'checking', true);
    // Keep one shared entries array so the metadata arrival reuses the same
    // `entriesRef` and exercises the `sameEntries && scannedIndex < length`
    // rescan guard rather than falling through to the new-array path.
    const childEntries = [childEntry];
    const streamSlices = new Map<StreamTabId, StreamSlice>([
      [ROOT_STREAM, sliceWithEntries(ROOT_STREAM, [])],
      [CHILD, sliceWithEntries(CHILD, childEntries)],
    ]);
    withBoundSessionState((childState) => {
      const initial = buildStaticTranscriptState({
        childRosters: new Map(),
        maxRows: undefined,
        meta: SESSION_META,
        ownerKey: `stream:${CHILD}`,
        parentStream,
        repaintEpoch: 0,
        scrollbackStreamId: CHILD,
        streams: streamSlices,
        width: 80,
      });

      expect(initial.items).toEqual([]);
      expect(initial.scan.entriesRef).toBe(childEntries);
      expect(initial.scan.scannedIndex).toBe(0);

      childState.updateStreamMetadata(CHILD, {
        config: { model: 'kimi26T' },
      });
      const advanced = advanceStaticTranscriptState(initial, {
        childRosters: new Map(),
        maxRows: undefined,
        meta: SESSION_META,
        ownerKey: `stream:${CHILD}`,
        parentStream,
        scrollbackStreamId: CHILD,
        streams: streamSlices,
        width: 80,
      });

      expect(advanced.items.map((item) => item.id)).toEqual([
        'session-header',
        'a1',
      ]);
      expect(advanced.scan.scannedIndex).toBe(1);
    });
  });

  it('keeps the scan cursor and state identical while the scrollback slice is missing', () => {
    const initial = buildStaticTranscriptState({
      childRosters: new Map(),
      maxRows: undefined,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 0,
      scrollbackStreamId: STREAM_ID,
      streams: new Map(),
      width: 80,
    });

    const advanced = advanceStaticTranscriptState(initial, {
      childRosters: new Map(),
      maxRows: undefined,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      scrollbackStreamId: STREAM_ID,
      streams: new Map(),
      width: 80,
    });

    expect(advanced).toBe(initial);
    expect(advanced.scan).toBe(initial.scan);
    expect(advanced.repaintEpoch).toBe(initial.repaintEpoch);
  });

  it('rebuilds once, then stays stable, when the scrollback slice disappears', () => {
    const settled = entry('a1', 'assistant', 'ok', true);
    const present = new Map<StreamTabId, StreamSlice>([
      [STREAM_ID, sliceWithEntries(STREAM_ID, [settled])],
    ]);
    const initial = buildStaticTranscriptState({
      childRosters: new Map(),
      maxRows: undefined,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 0,
      scrollbackStreamId: STREAM_ID,
      streams: present,
      width: 80,
    });
    const advancedOnce = advanceStaticTranscriptState(initial, {
      childRosters: new Map(),
      maxRows: undefined,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      scrollbackStreamId: STREAM_ID,
      streams: present,
      width: 80,
    });

    expect(advancedOnce.scan.scannedIndex).toBe(1);

    const missing = advanceStaticTranscriptState(advancedOnce, {
      childRosters: new Map(),
      maxRows: undefined,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      scrollbackStreamId: STREAM_ID,
      streams: new Map(),
      width: 80,
    });

    expect(missing.repaintEpoch).toBe(advancedOnce.repaintEpoch + 1);

    const missingAgain = advanceStaticTranscriptState(missing, {
      childRosters: new Map(),
      maxRows: undefined,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      scrollbackStreamId: STREAM_ID,
      streams: new Map(),
      width: 80,
    });

    expect(missingAgain).toBe(missing);
    expect(missingAgain.scan).toBe(missing.scan);
    expect(missingAgain.repaintEpoch).toBe(missing.repaintEpoch);
  });

  it('recomputes ring totals and trims when the layout width shrinks', () => {
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 6,
      rowLowWater: 4,
      byteHighWater: 1024 * 1024,
      byteLowWater: 1024 * 1024,
    };
    const entries = Array.from({ length: 4 }, (_, index) =>
      entry(`e${index}`, 'assistant', 'x'.repeat(10), true),
    );
    const wideStreams = new Map<StreamTabId, StreamSlice>([
      [STREAM_ID, sliceWithEntries(STREAM_ID, entries)],
    ]);
    const wide = buildStaticTranscriptState({
      childRosters: new Map(),
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 0,
      ringBudgets: budgets,
      scrollbackStreamId: STREAM_ID,
      streams: wideStreams,
      width: 40,
    });

    expect(wide.items.map((item) => item.id)).toEqual([
      'session-header',
      'e0',
      'e1',
      'e2',
      'e3',
    ]);
    expect(wide.rowCount).toBeLessThanOrEqual(budgets.rowHighWater);
    expect(wide.repaintEpoch).toBe(0);

    const narrow = advanceStaticTranscriptState(wide, {
      childRosters: new Map(),
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      ringBudgets: budgets,
      scrollbackStreamId: STREAM_ID,
      streams: wideStreams,
      width: 8,
    });

    expect(narrow.items.map((item) => item.id)).toEqual([
      'session-header',
      'e3',
    ]);
    expect(narrow.rowCount).toBeLessThanOrEqual(budgets.rowLowWater);
    expect(narrow.repaintEpoch).toBe(1);
    expect(narrow.layoutWidth).toBe(8);
  });

  it('recomputes ring byte totals and trims when execution labels change', () => {
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 10,
      rowLowWater: 1,
      byteHighWater: 250,
      byteLowWater: 1,
    };
    const shortLabels = new Map<string, string>([['sub', 'A']]);
    const longLabels = new Map<string, string>([['sub', 'A'.repeat(60)]]);
    const entries = [
      compactExecutionsEntry('t1', '/executions/sub/report'),
      compactExecutionsEntry('t2', '/executions/sub/report'),
    ];
    const streamMap = new Map<StreamTabId, StreamSlice>([
      [STREAM_ID, sliceWithEntries(STREAM_ID, entries)],
    ]);
    const initial = buildStaticTranscriptState({
      childRosters: new Map(),
      executionLabels: shortLabels,
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 0,
      ringBudgets: budgets,
      scrollbackStreamId: STREAM_ID,
      streams: streamMap,
      width: 80,
    });

    expect(initial.items.map((item) => item.id)).toEqual([
      'session-header',
      't1',
      't2',
    ]);
    expect(initial.byteCount).toBeLessThanOrEqual(budgets.byteHighWater);
    expect(initial.repaintEpoch).toBe(0);

    const advanced = advanceStaticTranscriptState(initial, {
      childRosters: new Map(),
      executionLabels: longLabels,
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      ringBudgets: budgets,
      scrollbackStreamId: STREAM_ID,
      streams: streamMap,
      width: 80,
    });

    expect(advanced.items.map((item) => item.id)).toEqual([
      'session-header',
      't2',
    ]);
    expect(advanced.byteCount).toBeGreaterThan(initial.byteCount);
    expect(advanced.repaintEpoch).toBe(1);
    expect(advanced.executionLabels).toBe(longLabels);
  });

  it('does not relayout or repaint for semantically equal fresh execution labels', () => {
    const labels = new Map<string, string>([['sub', 'A']]);
    const entries = [compactExecutionsEntry('t1', '/executions/sub/report')];
    const streamMap = new Map<StreamTabId, StreamSlice>([
      [STREAM_ID, sliceWithEntries(STREAM_ID, entries)],
    ]);
    const initial = buildStaticTranscriptState({
      childRosters: new Map(),
      executionLabels: labels,
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 0,
      ringBudgets: DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
      scrollbackStreamId: STREAM_ID,
      streams: streamMap,
      width: 80,
    });
    // Same projection contents in a fresh Map — the signal allocates these on
    // unrelated child-roster churn, so they must not read as a layout change.
    const sameLabelsFreshMap = new Map<string, string>([['sub', 'A']]);
    const unchanged = advanceStaticTranscriptState(initial, {
      childRosters: new Map(),
      executionLabels: sameLabelsFreshMap,
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      ringBudgets: DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
      scrollbackStreamId: STREAM_ID,
      streams: streamMap,
      width: 80,
    });
    expect(unchanged).toBe(initial);
    expect(unchanged.repaintEpoch).toBe(initial.repaintEpoch);
  });

  it('trims and bumps the repaint epoch when incremental appends exceed a small budget', () => {
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 2,
      rowLowWater: 1,
      byteHighWater: 1024 * 1024,
      byteLowWater: 1024 * 1024,
    };
    const firstEntry = entry('e0', 'assistant', 'x', true);
    const firstStreams = new Map<StreamTabId, StreamSlice>([
      [STREAM_ID, sliceWithEntries(STREAM_ID, [firstEntry])],
    ]);
    const initial = buildStaticTranscriptState({
      childRosters: new Map(),
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 0,
      ringBudgets: budgets,
      scrollbackStreamId: STREAM_ID,
      streams: firstStreams,
      width: 80,
    });

    expect(initial.items.map((item) => item.id)).toEqual([
      'session-header',
      'e0',
    ]);
    expect(initial.repaintEpoch).toBe(0);

    const secondEntry = entry('e1', 'assistant', 'y', true);
    const appendedStreams = new Map<StreamTabId, StreamSlice>([
      [STREAM_ID, sliceWithEntries(STREAM_ID, [firstEntry, secondEntry])],
    ]);
    const advanced = advanceStaticTranscriptState(initial, {
      childRosters: new Map(),
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      ringBudgets: budgets,
      scrollbackStreamId: STREAM_ID,
      streams: appendedStreams,
      width: 80,
    });

    expect(advanced.items.map((item) => item.id)).toEqual([
      'session-header',
      'e1',
    ]);
    expect(advanced.repaintEpoch).toBe(1);
  });

  it('does not report a trim when only the header and one oversized entry remain', () => {
    const header: StaticTranscriptItem = {
      id: 'session-header',
      kind: 'header',
      compact: true,
      identityLine: 'agent: research · model: test',
      meta: SESSION_META,
    };
    const oversized: StaticTranscriptItem = {
      id: 'e0',
      kind: 'entry',
      entry: entry('e0', 'assistant', 'x'.repeat(80), true),
    };
    const trimmed = trimStaticTranscriptItems([header, oversized], {
      budgets: {
        rowHighWater: 1,
        rowLowWater: 1,
        byteHighWater: 1,
        byteLowWater: 1,
      },
      totals: { rows: 20, bytes: 500 },
      width: 80,
    });

    expect(trimmed.items.map((item) => item.id)).toEqual([
      'session-header',
      'e0',
    ]);
    expect(trimmed.trimmed).toBe(false);
  });

  it('does not bump the repaint epoch on a scrollback owner switch', () => {
    const rootStreams = new Map<StreamTabId, StreamSlice>([
      [
        STREAM_ID,
        sliceWithEntries(STREAM_ID, [entry('e0', 'assistant', 'root', true)]),
      ],
    ]);
    const initial = buildStaticTranscriptState({
      childRosters: new Map(),
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'root',
      parentStream: new Map(),
      repaintEpoch: 5,
      scrollbackStreamId: STREAM_ID,
      streams: rootStreams,
      width: 80,
    });
    expect(initial.repaintEpoch).toBe(5);

    const switched = advanceStaticTranscriptState(initial, {
      childRosters: new Map(),
      maxRows: 1,
      meta: SESSION_META,
      ownerKey: 'stream:other',
      parentStream: new Map(),
      scrollbackStreamId: STREAM_ID,
      streams: rootStreams,
      width: 80,
    });

    expect(switched.ownerKey).toBe('stream:other');
    expect(switched.repaintEpoch).toBe(5);
  });

  it('appends settled entries incrementally and resumes a deferred live prompt', () => {
    const user = entry('u1', 'user', 'what is this repo about', true);
    const assistantPending = entry('a1', 'assistant', 'working', false);
    const assistantSettled = settled(assistantPending);
    const emptyCursor = {
      entriesRef: undefined,
      scannedIndex: 0,
      lastScannedEntry: undefined,
      status: undefined,
    } as const;

    const first = incrementalStaticTranscriptEntries(
      [user],
      0,
      STREAM_PHASE.RUNNING,
      emptyCursor,
    );
    expect(first.appended).toEqual([]);
    expect(first.cursor.scannedIndex).toBe(0);

    const second = incrementalStaticTranscriptEntries(
      [user, assistantPending],
      0,
      STREAM_PHASE.RUNNING,
      first.cursor,
    );
    expect(second.appended.map((item) => item.id)).toEqual(['u1']);
    expect(second.cursor.scannedIndex).toBe(1);

    const third = incrementalStaticTranscriptEntries(
      [user, assistantSettled],
      0,
      STREAM_PHASE.RUNNING,
      second.cursor,
    );
    expect(third.appended.map((item) => item.id)).toEqual(['a1']);
    expect(third.cursor.scannedIndex).toBe(2);
  });

  it('labels preset-launched sessions with team and root identity', () => {
    expect(
      sessionHeaderIdentityLine({
        ...SESSION_META,
        agent: 'orchestrator',
        model: 'gpt56-',
        teamName: 'Physicist',
      }),
    ).toBe('team: Physicist · root: orchestrator · model: GPT-5.6 Terra');
    expect(sessionHeaderIdentityLine(SESSION_META)).toBe(
      'agent: research · model: DeepSeek V4 Flash (Thinking)',
    );
  });

  it('keeps session metadata authoritative for root stream identity', () => {
    const streams = new Map<StreamTabId, StreamSlice>([
      [ROOT_STREAM, sliceWithEntries(ROOT_STREAM, [])],
    ]);
    withBoundSessionState((childState) => {
      // Stale stream metadata must not leak into an unparented root header.
      childState.updateStreamMetadata(ROOT_STREAM, {
        config: { model: 'previous-model' },
      });

      expect(
        sessionHeaderIdentityLine(
          {
            ...SESSION_META,
            agent: 'current-agent',
            model: 'current-model',
          },
          {
            streamId: ROOT_STREAM,
            streams,
          },
        ),
      ).toBe('agent: current-agent · model: current-model');
    });
  });

  it('labels focused subagent scrollback with the child stream identity', () => {
    const CHILD = 'search-stream' as StreamTabId;
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        ROOT_STREAM,
        sliceWithEntries(ROOT_STREAM, [
          entry('u1', 'user', 'send scouts', true),
        ]),
      ],
      [CHILD, sliceWithEntries(CHILD, [entry('a1', 'assistant', 'ok', true)])],
    ]);
    const childRosters = buildChildRosters({
      parentStreamId: ROOT_STREAM,
      rows: [
        {
          executionId: 'ei_search',
          agentName: 'search',
          identity: { kind: 'agent' as const, agent: 'search' },
          childStreamId: CHILD,
          status: STREAM_PHASE.RUNNING,
        },
      ],
    });

    withBoundSessionState((childState) => {
      childState.updateStreamMetadata(CHILD, {
        config: { model: 'kimi26T' },
      });

      expect(
        sessionHeaderIdentityLine(SESSION_META, {
          childRosters,
          parentStream: new Map([[CHILD, ROOT_STREAM]]),
          streamId: CHILD,
          streams,
        }),
      ).toBe('subagent: search · parent: main · model: Kimi K2.6 (Thinking)');

      const WORKFLOW = 'workflow-stream' as StreamTabId;
      const TASK = 'task-stream' as StreamTabId;
      const workflowStreams = new Map<StreamTabId, StreamSlice>([
        [ROOT_STREAM, sliceWithEntries(ROOT_STREAM, [])],
        [
          WORKFLOW,
          sliceWithEntries(WORKFLOW, [phaseRow('phase-1', 'Survey', 0, 1)]),
        ],
        [TASK, sliceWithEntries(TASK, [entry('a1', 'assistant', 'ok', true)])],
      ]);
      childState.updateStreamMetadata(WORKFLOW, {
        identity: { kind: 'multiAgentWorkflow', workflowName: 'survey' },
        agentCategory: AgentCategory.Workflow,
        config: { model: 'kimi26T' },
      });
      childState.updateStreamMetadata(TASK, {
        config: { model: 'kimi26T' },
      });
      const workflowChildren = new Map([
        ...buildChildRosters({
          parentStreamId: ROOT_STREAM,
          rows: [
            {
              executionId: 'ei_wf',
              agentName: 'survey',
              identity: {
                kind: 'multiAgentWorkflow' as const,
                workflowName: 'survey',
              },
              childStreamId: WORKFLOW,
              status: STREAM_PHASE.RUNNING,
            },
          ],
        }),
        ...buildChildRosters({
          parentStreamId: WORKFLOW,
          rows: [
            {
              executionId: 'ei_task',
              agentName: 'Agent runtime + its tests',
              identity: {
                kind: 'agent' as const,
                agent: 'Agent runtime + its tests',
              },
              childStreamId: TASK,
              status: STREAM_PHASE.RUNNING,
            },
          ],
        }),
      ]);
      expect(
        sessionHeaderIdentityLine(SESSION_META, {
          childRosters: workflowChildren,
          parentStream: new Map([
            [WORKFLOW, ROOT_STREAM],
            [TASK, WORKFLOW],
          ]),
          streamId: TASK,
          streams: workflowStreams,
        }),
      ).toBe(
        'subagent: Agent runtime + its tests · Survey (1/1) · parent: survey · model: Kimi K2.6 (Thinking)',
      );

      expect(
        buildStaticTranscriptItems({
          scrollbackStreamId: CHILD,
          currentItems: [],
          streams,
          childRosters,
          meta: SESSION_META,
          parentStream: new Map([[CHILD, ROOT_STREAM]]),
        }).items[0],
      ).toMatchObject({
        kind: 'header',
        identityLine:
          'subagent: search · parent: main · model: Kimi K2.6 (Thinking)',
      });
    });
  });

  it('waits for child task state before printing a focused subagent header', () => {
    const CHILD = 'search-stream' as StreamTabId;
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [CHILD, ROOT_STREAM],
    ]);
    const childEntry = entry('a1', 'assistant', 'checking', true);
    const streamSlices = new Map<StreamTabId, StreamSlice>([
      [ROOT_STREAM, sliceWithEntries(ROOT_STREAM, [])],
      [CHILD, sliceWithEntries(CHILD, [childEntry])],
    ]);

    withBoundSessionState((childState) => {
      expect(
        buildStaticTranscriptItems({
          scrollbackStreamId: CHILD,
          currentItems: [],
          streams: streamSlices,
          meta: SESSION_META,
          parentStream,
        }).items,
      ).toEqual([]);

      childState.updateStreamMetadata(CHILD, {
        config: { model: 'kimi26T' },
      });

      expect(
        buildStaticTranscriptItems({
          scrollbackStreamId: CHILD,
          currentItems: [],
          streams: streamSlices,
          meta: SESSION_META,
          parentStream,
        }).items.map((item) => item.id),
      ).toEqual(['session-header', 'a1']);
    });
  });

  it('only feeds the root scrollback stream, not background subagents', () => {
    const items = buildStaticTranscriptItems({
      scrollbackStreamId: ROOT_STREAM,
      currentItems: [],
      streams: rootChildStreams('do x', 'done'),
      meta: SESSION_META,
    }).items;

    expect(items.slice(1).map((item) => item.id)).toEqual(['u1']);
  });

  it('keeps background children out of the root scrollback owner', () => {
    const scrollbackTarget = staticScrollbackTarget({
      activeStreamId: CHILD_STREAM,
      rootStreamId: ROOT_STREAM,
      scopedTranscript: false,
    });
    const items = buildStaticTranscriptItems({
      scrollbackStreamId: scrollbackTarget.streamId,
      currentItems: [],
      streams: rootChildStreams('root prompt', 'child detail'),
      meta: SESSION_META,
    }).items;

    expect(scrollbackTarget).toEqual({
      ownerKey: 'root',
      streamId: ROOT_STREAM,
    });
    expect(items.slice(1).map((item) => item.id)).toEqual(['u1']);
  });

  it('uses the focused child as the static scrollback owner in scoped view', () => {
    const scrollbackTarget = staticScrollbackTarget({
      activeStreamId: CHILD_STREAM,
      rootStreamId: ROOT_STREAM,
      scopedTranscript: true,
    });
    const items = buildStaticTranscriptItems({
      scrollbackStreamId: scrollbackTarget.streamId,
      currentItems: [],
      streams: rootChildStreams('root prompt', 'child detail'),
      meta: SESSION_META,
    }).items;

    expect(scrollbackTarget).toEqual({
      ownerKey: `stream:${CHILD_STREAM}`,
      streamId: CHILD_STREAM,
    });
    expect(items.slice(1).map((item) => item.id)).toEqual(['a1']);
  });

  it('keeps the root static owner stable while the root stream resolves', () => {
    expect(
      staticScrollbackTarget({
        activeStreamId: STREAM_ID,
        rootStreamId: undefined,
      }),
    ).toEqual({ ownerKey: 'root', streamId: STREAM_ID });
    expect(
      staticScrollbackTarget({
        activeStreamId: CLI_LOCAL_STREAM_ID,
        rootStreamId: undefined,
      }),
    ).toEqual({ ownerKey: 'root', streamId: CLI_LOCAL_STREAM_ID });
    expect(
      staticScrollbackTarget({
        activeStreamId: STREAM_ID,
        rootStreamId: 'resolved-root' as StreamTabId,
      }),
    ).toEqual({ ownerKey: 'root', streamId: 'resolved-root' });
  });

  it('separates root scrollback from scoped child transcript viewports', () => {
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [CHILD_STREAM, ROOT_STREAM],
    ]);
    const rootViewportKey = transcriptViewportKey({
      activeStreamId: ROOT_STREAM,
      parentStream,
    });
    const childViewportKey = transcriptViewportKey({
      activeStreamId: CHILD_STREAM,
      parentStream,
    });

    expect(rootViewportKey).toBe('root-scrollback');
    expect(childViewportKey).toBe(`scoped:${CHILD_STREAM}`);
  });

  it('repaints static transcript invalidations from a clean origin', () => {
    const calls: TuiRepaintOptions[] = [];
    const controller = createTuiViewportController({
      current: {
        repaint: (options) => {
          calls.push(options);
        },
      },
    });

    staticTranscriptRepaintEpoch.set(0);
    controller.repaintTranscript();
    controller.repaintAfterTerminalResume();

    expect(calls).toEqual([{ clearScrollback: true, preserveStatic: false }]);
    expect(staticTranscriptRepaintEpoch.get()).toBe(1);
  });

  it('detects generated inquiry continuation rows only', () => {
    expect(
      isInquiryContinuationText(
        '[inquiry] ei_123 answered.\nQ: Can this be simplified?\nA: Yes.',
      ),
    ).toBe(true);
    expect(
      isInquiryContinuationText(
        '[inquiry] ei_456 dropped by user.\nQ: Should we proceed?',
      ),
    ).toBe(true);
    expect(isInquiryContinuationText('[inquiry] ei_789 answered.')).toBe(true);
    expect(
      isInquiryContinuationText('[inquiry] ei_789 answered. extra text'),
    ).toBe(false);
    expect(isInquiryContinuationText(' [inquiry] ei_789 answered.')).toBe(
      false,
    );
    expect(isInquiryContinuationText('Run the analysis')).toBe(false);
  });

  it('compacts adjacent one-line tool rows in full output', () => {
    const lines = transcriptToLines(
      sliceWithEntries(STREAM_ID, [
        compactExecutionsEntry('t1', '/executions/3a780a389327/report'),
        compactExecutionsEntry('t2', '/executions/3a780a389327/conversation'),
      ]),
      80,
    );

    expect(lines).toEqual([
      '● executions (view /executions/3a780a389327/report)',
      '● executions (view /executions/3a780a389327/conversation)',
    ]);
  });

  it('keeps full-output separators around prose and detailed tool rows', () => {
    const lines = transcriptToLines(
      sliceWithEntries(STREAM_ID, [
        compactExecutionsEntry('t1', '/executions/3a780a389327/report'),
        entry('a1', 'assistant', 'Read the report.', true),
        toolEntry('t2', 'completed'),
      ]),
      80,
    );

    expect(lines).toEqual([
      '● executions (view /executions/3a780a389327/report)',
      '',
      'Read the report.',
      '',
      '● Bash (ls)',
      '⎿ ok',
    ]);
  });

  it('wraps wide tool output lines for terminal printing', () => {
    const lines = transcriptToLines(
      sliceWithEntries(STREAM_ID, [
        toolEntry('t1', 'completed', `wide-output ${'segment '.repeat(12)}`),
      ]),
      32,
    );

    expect(lines).toContain('● Bash (ls)');
    expect(lines.some((line) => line.includes('⎿ wide-output'))).toBe(true);
    expect(lines.some((line) => line.includes('segment segment'))).toBe(true);
    expect(lines.some((line) => line.length > 40)).toBe(false);
  });

  it('prints hydrated spill output once for detailed and compact tools', () => {
    const bash = {
      ...toolEntry('bash', 'completed', 'complete bash output'),
      spillPath: 'executions/abcdef123456/toolOutput/bash.txt',
    };
    const read = {
      ...toolEntry('read', 'completed', 'complete read output', {
        toolName: 'read_file',
      }),
      spillPath: 'executions/abcdef123456/toolOutput/read.txt',
    };

    const lines = transcriptToLines(
      sliceWithEntries(STREAM_ID, [bash, read]),
      80,
    );

    expect(
      lines.filter((line) => line.includes('complete bash output')),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes('complete read output')),
    ).toHaveLength(1);
    expect(lines).toContain('Full output:');
  });

  it('keeps a failed compact-tool spill visible in the full transcript', () => {
    const spillPath = 'executions/abcdef123456/toolOutput/read.txt';
    const read = {
      ...toolEntry('read', 'completed', 'preview', { toolName: 'read_file' }),
      spillPath,
    };
    const notice =
      '[Full output is unavailable because this run artifact was deleted.]';

    const hydrated = hydratedTranscript(
      sliceWithEntries(STREAM_ID, [read]),
      new Map([[spillPath, { kind: 'failed' as const, notice }]]),
    );

    expect(hydrated?.entries[0]?.spillPath).toBe(spillPath);
    expect(hydrated?.entries[0]?.spillFailed).toBe(true);
    const lines = transcriptToLines(hydrated, 80);
    // The failure notice renders without a "Full output:" header — the header
    // promises recovered output that a failed spill does not have.
    expect(lines).toContainEqual(expect.stringContaining(notice));
    expect(lines).not.toContain('Full output:');
  });

  it('uses the full print width without Ink-only role padding', () => {
    const entries = [
      entry('u1', 'user', 'user text', true),
      entry('e1', 'error', 'error text', true),
    ];

    for (const transcriptEntry of entries) {
      const normal = transcriptEntryLayout(transcriptEntry, {
        mode: 'scrollback-budget',
        width: 20,
      });
      const printed = fullTranscriptEntryLayout(transcriptEntry, 20);
      expect(normal.columns).toBe(18);
      expect(printed.columns).toBe(20);
      expect(printed.lines.every((line) => line.length <= 20)).toBe(true);
    }
  });
});

function sliceWithEntries(
  streamId: StreamTabId,
  entries: readonly TranscriptRow[],
  init: Partial<StreamSlice> = {},
): StreamSlice {
  return { ...emptySlice(streamId), entries, ...init };
}

/** Bind a fresh `SessionState` for tests that read stream metadata (child
 *  identity latch, header model labels), unbinding on the way out. */
function withBoundSessionState(run: (state: SessionState) => void): void {
  const state = new SessionState(defaultSession());
  bindChildStreamState(state);
  try {
    run(state);
  } finally {
    unbindChildStreamState(state);
  }
}

/** A root stream with one user entry plus a background child stream. */
function rootChildStreams(
  rootText: string,
  childText: string,
): Map<StreamTabId, StreamSlice> {
  return new Map([
    [
      ROOT_STREAM,
      sliceWithEntries(ROOT_STREAM, [entry('u1', 'user', rootText, true)]),
    ],
    [
      CHILD_STREAM,
      sliceWithEntries(CHILD_STREAM, [
        entry('a1', 'assistant', childText, true),
      ]),
    ],
  ]);
}

/** Static scrollback for a single-stream transcript of `entries`. */
function staticItems(
  entries: readonly TranscriptRow[],
  options: {
    readonly currentItems?: readonly StaticTranscriptItem[];
    readonly maxRows?: number;
    readonly width?: number;
  } = {},
): readonly StaticTranscriptItem[] {
  return buildStaticTranscriptItems({
    currentItems: options.currentItems ?? [],
    maxRows: options.maxRows,
    meta: SESSION_META,
    scrollbackStreamId: STREAM_ID,
    streams: new Map([[STREAM_ID, sliceWithEntries(STREAM_ID, entries)]]),
    width: options.width,
  }).items;
}

function staticItemIds(
  entries: readonly TranscriptRow[],
  options: Parameters<typeof staticItems>[1] = {},
): readonly string[] {
  return staticItems(entries, options).map((item) => item.id);
}
