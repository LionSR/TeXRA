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
  isInquiryContinuationText,
  splitTranscriptEntries,
  terminalVisibleTranscriptText,
  trimAssistantTranscriptLead,
} from '@cli/chat/tui/panes/transcriptEntries';
import {
  appendStaticTranscriptItems,
  sessionHeaderIdentityLine,
  type StaticTranscriptItem,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import { staticScrollbackTarget } from '@cli/chat/tui/appLayout';
import { transcriptViewportKey } from '@cli/chat/tui/state/transcriptViewportMode';
import {
  createTuiViewportController,
  type TuiRepaintOptions,
} from '@cli/chat/tui/render/tuiViewportController';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
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
  type ConversationEntry,
  type StreamSlice,
  setStreamStatusInCliState,
} from '@cli/chat/tui/state/cliState';
import { transcriptToLines } from '@cli/chat/tui/state/transcriptLines';
import { CLI_LOCAL_STREAM_ID } from '@cli/chat/tui/state/transcript';
import { projectStreamTranscript } from '@cli/chat/tui/state/transcriptProjection';
import { subscribeStreamStatus } from '@cli/chat/tui/state/subscribeStreamStatus';
import {
  AgentCategory,
  RUN_OUTCOME,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type NormalizedToolUse,
  type RunOutcome,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { COMPACTION_ACTIVITY_LABEL } from '@shared/streams/compactionActivityProjection';
import { buildChildStreamEntries } from '@test/support/childStreamEntries';

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

function entry(
  id: string,
  role: 'assistant' | 'error' | 'user',
  text: string,
  finalized: boolean,
): ConversationEntry {
  return { id, role, text, finalized };
}

function compactionEntry(
  status: 'running' | 'interrupted' | 'completed',
  finalized = status === 'completed',
): ConversationEntry {
  return {
    id: 'compaction:operation-1',
    role: 'activity',
    text: COMPACTION_ACTIVITY_LABEL[status],
    finalized,
    activity: {
      operationId: 'operation-1',
      status,
      finalized,
      startPosition: 1,
      startedAt: 100,
      ...(status !== 'running' ? { finishedAt: 200 } : {}),
    },
  };
}

function toolEntry(
  id: string,
  status: NormalizedToolUse['status'],
  outputText = status === 'completed' ? 'ok' : '',
): Extract<ConversationEntry, { role: 'tool' }> {
  return {
    id,
    role: 'tool',
    text: '',
    finalized: false,
    toolUse: {
      toolName: 'Bash',
      errorText: '',
      outputText,
      userInstructionText: '',
      input: { command: 'ls' },
      isError: false,
      isUserFeedback: false,
      headerSummary: '',
      status,
    },
  };
}

function compactExecutionsEntry(
  id: string,
  path: string,
): Extract<ConversationEntry, { role: 'tool' }> {
  return {
    id,
    role: 'tool',
    text: '',
    finalized: true,
    toolUse: {
      toolName: 'executions',
      errorText: '',
      outputText: '',
      userInstructionText: '',
      input: { path },
      isError: false,
      isUserFeedback: false,
      headerSummary: '',
      status: TOOL_USE_STATUS.COMPLETED,
    },
  };
}

describe('CLI conversation transcript', () => {
  it('keeps only explicit finalized entries in scrollback', () => {
    const user = entry('u1', 'user', '1+1', true);
    const assistant = entry('a1', 'assistant', '2', false);

    const running = splitTranscriptEntries(
      [user, assistant],
      STREAM_PHASE.RUNNING,
    );
    expect(running.finalized).toEqual([user]);
    expect(running.pending).toEqual([assistant]);

    const waitingBeforeFinalize = splitTranscriptEntries(
      [user, assistant],
      STREAM_PHASE.WAITING,
    );
    expect(waitingBeforeFinalize.finalized).toEqual([user]);
    expect(waitingBeforeFinalize.pending).toEqual([]);
  });

  it('keeps running compaction live and promotes its terminal update once', () => {
    const running = compactionEntry('running');
    expect(
      splitTranscriptEntries([running], STREAM_PHASE.RUNNING).pending,
    ).toEqual([running]);
    expect(staticItemIds([running])).toEqual(['session-header']);

    const completed = compactionEntry('completed');
    expect(
      splitTranscriptEntries([completed], STREAM_PHASE.RUNNING).finalized,
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
      splitTranscriptEntries([interrupted, laterUser], STREAM_PHASE.RUNNING)
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

    expect(layout.role).toBe('activity');
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

    projectStreamTranscript(STREAM_ID, { finalize: true });

    const slice = streams.get().get(STREAM_ID);
    expect(slice?.entries.map((item) => item.finalized)).toEqual([true, true]);
    const split = splitTranscriptEntries(
      slice?.entries ?? [],
      STREAM_PHASE.WAITING,
    );
    expect(split.finalized.map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(split.pending).toEqual([]);
  });

  it.each(Object.values(RUN_OUTCOME) as RunOutcome[])(
    'freezes assistant entries on the %s outcome',
    (outcome) => {
      defaultSession().status.clearStream(STREAM_ID);
      resetCliState();
      patchStream(STREAM_ID, (slice) => ({
        ...slice,
        entries: [entry('a1', 'assistant', 'A final answer.', false)],
      }));
      const dispose = subscribeStreamStatus();

      try {
        defaultSession().status.transition(
          STREAM_ID,
          outcome,
          'restart-repair',
        );

        expect(
          streams
            .get()
            .get(STREAM_ID)
            ?.entries.map((item) => ({
              id: item.id,
              finalized: item.finalized,
            })),
        ).toEqual([{ id: 'a1', finalized: true }]);
      } finally {
        dispose();
        defaultSession().status.clearStream(STREAM_ID);
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
    const dispose = subscribeStreamStatus();

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
    resetCliState();
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [
        entry('a1', 'assistant', 'about to run a tool', false),
        toolEntry('t1', 'completed'),
      ],
    }));

    let split = splitTranscriptEntries(
      streams.get().get(STREAM_ID)?.entries ?? [],
      STREAM_PHASE.RUNNING,
    );
    expect(split.finalized).toHaveLength(0);
    expect(split.pending.map((e) => e.id)).toEqual(['a1', 't1']);

    projectStreamTranscript(STREAM_ID, { finalize: true });

    split = splitTranscriptEntries(
      streams.get().get(STREAM_ID)?.entries ?? [],
      STREAM_PHASE.WAITING,
    );
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
    const malformedTool = {
      ...toolEntry('tool', TOOL_USE_STATUS.IN_PROGRESS).toolUse,
      toolName: {} as string,
    } as NormalizedToolUse;
    const malformedEntry: ConversationEntry = {
      id: 'tool',
      role: 'tool',
      text: '',
      finalized: false,
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

    const assistant = (finalized: boolean): ConversationEntry => ({
      finalized,
      id: finalized ? 'finalized' : 'streaming',
      role: 'assistant',
      text,
    });
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
      (task) =>
        transcriptEntryLayout(
          {
            id: 'a',
            role: 'workflowTask',
            text: 'Task',
            finalized: true,
            task,
          },
          { width: 80 },
        ).lines[0] ?? '',
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
      {
        id: 'a',
        role: 'workflowTask',
        text: `Finished: ${'w'.repeat(40)} ${'x'.repeat(40)}`,
        finalized: true,
        task: { id: 'a', label: 'Task', status: 'completed', durationMs: 1 },
      },
      { width: 40 },
    );

    expect(layout.lines[0]?.startsWith('  ☑ ')).toBe(true);
    expect(layout.lines.slice(1).every((line) => line.startsWith('    '))).toBe(
      true,
    );
    expect(layout.lines.length).toBeGreaterThan(1);
  });

  it('budgets live rich tool rows without reflowing their display lines', () => {
    const base = toolEntry('t1', TOOL_USE_STATUS.COMPLETED);
    const tool: ConversationEntry = {
      ...base,
      toolUse: {
        ...base.toolUse,
        input: { command: 'x'.repeat(80) },
      },
    };
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

  it('clips a standalone loaded-image event to one transcript row', () => {
    const media: ConversationEntry = {
      id: 'media-1',
      role: 'media',
      text: '',
      finalized: true,
      images: [
        {
          path: '/private/tmp/plot-with-a-long-name.png',
          sizeBytes: 8704,
        },
      ],
    };
    const layout = transcriptEntryLayout(media, { width: 24 });

    expect(layout.lines).toEqual(['› [image] /pr… (8.5 KiB)']);
    expect(textDisplayWidth(layout.lines[0] ?? '')).toBe(24);
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
      staticItemIds([
        user,
        { ...emptyAssistant, finalized: true },
        { ...tool, finalized: true },
      ]),
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

    const split = splitTranscriptEntries([user], STREAM_PHASE.RUNNING);
    expect(split.finalized).toEqual([]);
    expect(split.pending.map((item) => item.id)).toEqual(['u1']);

    const items = appendStaticTranscriptItems({
      scrollbackStreamId: STREAM_ID,
      currentItems: [],
      streams,
      meta: SESSION_META,
    });
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

    const split = splitTranscriptEntries([user, tool], STREAM_PHASE.RUNNING);
    expect(split.finalized.map((item) => item.id)).toEqual(['u1']);
    expect(split.pending.map((item) => item.id)).toEqual(['t1']);

    const items = appendStaticTranscriptItems({
      scrollbackStreamId: STREAM_ID,
      currentItems: [],
      streams,
      meta: SESSION_META,
    });
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

    expect(terminalVisibleTranscriptText(invisibleAssistant.text)).toBe('\n\n');
    expect(trimAssistantTranscriptLead(invisibleAssistant.text)).toBe('');
    expect(trimAssistantTranscriptLead('\u001B[2m\u200B\nvisible')).toBe(
      '\u001B[2mvisible',
    );
    expect(trimAssistantTranscriptLead('\n\u001B[31mvisible')).toBe(
      '\u001B[31mvisible',
    );
    expect(
      splitTranscriptEntries(
        [user, invisibleAssistant, tool],
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

    const second = staticItems([user, { ...assistant, finalized: true }], {
      currentItems: first,
    });
    expect(second).toHaveLength(3);
    expect(second.slice(1).map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('shows the session header exactly once', () => {
    const first = appendStaticTranscriptItems({
      scrollbackStreamId: undefined,
      currentItems: [],
      streams: new Map(),
      meta: SESSION_META,
    });
    expect(first).toHaveLength(1);

    const again = appendStaticTranscriptItems({
      scrollbackStreamId: undefined,
      currentItems: first,
      streams: new Map(),
      meta: { ...SESSION_META, model: 'sonnet' },
    });
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
      finalized: true,
    } satisfies ConversationEntry;
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

  it('labels preset-launched sessions with team and root identity', () => {
    expect(
      sessionHeaderIdentityLine({
        ...SESSION_META,
        agent: 'orchestrator',
        teamName: 'Physicist',
      }),
    ).toBe('team: Physicist · root: orchestrator · model: deepseekT');
    expect(sessionHeaderIdentityLine(SESSION_META)).toBe(
      'agent: research · model: deepseekT',
    );
  });

  it('keeps session metadata authoritative for root stream identity', () => {
    const ROOT = 'root-stream' as StreamTabId;
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        ROOT,
        sliceWithEntries(ROOT, [], {
          model: 'previous-model',
        }),
      ],
    ]);

    expect(
      sessionHeaderIdentityLine(
        {
          ...SESSION_META,
          agent: 'current-agent',
          model: 'current-model',
        },
        {
          streamId: ROOT,
          streams,
        },
      ),
    ).toBe('agent: current-agent · model: current-model');
  });

  it('labels focused subagent scrollback with the child stream identity', () => {
    const ROOT = 'root-stream' as StreamTabId;
    const CHILD = 'search-stream' as StreamTabId;
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        ROOT,
        sliceWithEntries(ROOT, [entry('u1', 'user', 'send scouts', true)], {
          model: 'deepseekT',
        }),
      ],
      [
        CHILD,
        sliceWithEntries(CHILD, [entry('a1', 'assistant', 'ok', true)], {
          model: 'kimi26T',
        }),
      ],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: ROOT,
      activeOnly: [
        {
          executionId: 'ei_search',
          agentName: 'search',
          identity: { kind: 'agent' as const, agent: 'search' },
          childStreamId: CHILD,
          status: STREAM_PHASE.RUNNING,
        },
      ],
    });

    expect(
      sessionHeaderIdentityLine(SESSION_META, {
        childStreamEntries,
        parentStream: new Map([[CHILD, ROOT]]),
        streamId: CHILD,
        streams,
      }),
    ).toBe('subagent: search · parent: main · model: kimi26T');

    expect(
      appendStaticTranscriptItems({
        scrollbackStreamId: CHILD,
        currentItems: [],
        streams,
        childStreamEntries,
        meta: SESSION_META,
        parentStream: new Map([[CHILD, ROOT]]),
      })[0],
    ).toMatchObject({
      kind: 'header',
      identityLine: 'subagent: search · parent: main · model: kimi26T',
    });
  });

  it('waits for child task state before printing a focused subagent header', () => {
    const ROOT = 'root-stream' as StreamTabId;
    const CHILD = 'search-stream' as StreamTabId;
    const parentStream = new Map<StreamTabId, StreamTabId>([[CHILD, ROOT]]);
    const childEntry = entry('a1', 'assistant', 'checking', true);
    const streamsWithoutChildModel = new Map<StreamTabId, StreamSlice>([
      [ROOT, sliceWithEntries(ROOT, [])],
      [CHILD, sliceWithEntries(CHILD, [childEntry])],
    ]);

    expect(
      appendStaticTranscriptItems({
        scrollbackStreamId: CHILD,
        currentItems: [],
        streams: streamsWithoutChildModel,
        meta: SESSION_META,
        parentStream,
      }),
    ).toEqual([]);

    const streamsWithChildModel = new Map<StreamTabId, StreamSlice>([
      [ROOT, sliceWithEntries(ROOT, [])],
      [
        CHILD,
        sliceWithEntries(CHILD, [childEntry], {
          model: 'kimi26T',
        }),
      ],
    ]);

    expect(
      appendStaticTranscriptItems({
        scrollbackStreamId: CHILD,
        currentItems: [],
        streams: streamsWithChildModel,
        meta: SESSION_META,
        parentStream,
      }).map((item) => item.id),
    ).toEqual(['session-header', 'a1']);
  });

  it('only feeds the root scrollback stream, not background subagents', () => {
    const items = appendStaticTranscriptItems({
      scrollbackStreamId: ROOT_STREAM,
      currentItems: [],
      streams: rootChildStreams('do x', 'done'),
      meta: SESSION_META,
    });

    expect(items.slice(1).map((item) => item.id)).toEqual(['u1']);
  });

  it('keeps background children out of the root scrollback owner', () => {
    const scrollbackTarget = staticScrollbackTarget({
      activeStreamId: CHILD_STREAM,
      rootStreamId: ROOT_STREAM,
      scopedTranscript: false,
    });
    const items = appendStaticTranscriptItems({
      scrollbackStreamId: scrollbackTarget.streamId,
      currentItems: [],
      streams: rootChildStreams('root prompt', 'child detail'),
      meta: SESSION_META,
    });

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
    const items = appendStaticTranscriptItems({
      scrollbackStreamId: scrollbackTarget.streamId,
      currentItems: [],
      streams: rootChildStreams('root prompt', 'child detail'),
      meta: SESSION_META,
    });

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

    controller.repaintTranscript();
    controller.repaintAfterTerminalResume();

    expect(calls).toEqual([
      { clearScrollback: true, preserveStatic: false },
      { clearScrollback: true },
    ]);
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
  entries: readonly ConversationEntry[],
  init: Partial<StreamSlice> = {},
): StreamSlice {
  return { ...emptySlice(streamId), entries, ...init };
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
  entries: readonly ConversationEntry[],
  options: {
    readonly currentItems?: readonly StaticTranscriptItem[];
    readonly maxRows?: number;
    readonly width?: number;
  } = {},
): readonly StaticTranscriptItem[] {
  return appendStaticTranscriptItems({
    currentItems: options.currentItems ?? [],
    maxRows: options.maxRows,
    meta: SESSION_META,
    scrollbackStreamId: STREAM_ID,
    streams: new Map([[STREAM_ID, sliceWithEntries(STREAM_ID, entries)]]),
    width: options.width,
  });
}

function staticItemIds(
  entries: readonly ConversationEntry[],
  options: Parameters<typeof staticItems>[1] = {},
): readonly string[] {
  return staticItems(entries, options).map((item) => item.id);
}
