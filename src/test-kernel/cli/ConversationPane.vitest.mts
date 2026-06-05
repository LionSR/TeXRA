import { describe, expect, it } from 'vitest';

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  boundedAssistantDisplayLines,
  compactPrefixedDisplayRows,
  isInquiryContinuationText,
} from '@cli/chat/tui/panes/TranscriptEntry';
import { splitTranscriptEntries } from '@cli/chat/tui/panes/transcriptEntries';
import {
  appendStaticTranscriptItems,
  sessionHeaderIdentityLine,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import {
  transcriptViewportChange,
  transcriptViewportKey,
} from '@cli/chat/tui/state/transcriptViewportMode';
import {
  estimateLiveTranscriptEntryRows,
  estimateTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from '@cli/chat/tui/panes/transcriptViewport';
import {
  cliState,
  patchStream,
  resetCliState,
  type ConversationEntry,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';
import { transcriptToLines } from '@cli/chat/tui/state/transcriptLines';
import { finalizeAssistantTranscriptEntries } from '@cli/chat/tui/state/transcript';
import { subscribeStreamStatus } from '@cli/chat/tui/state/subscribeStreamStatus';
import {
  STREAM_STATUS,
  TOOL_USE_STATUS,
  type NormalizedToolUse,
  type StreamTabId,
} from '@shared/schemas';

const STREAM_ID = 'cli-test-stream' as StreamTabId;
const SESSION_META = {
  agent: 'research',
  model: 'deepseekT',
  cwd: '/tmp/project',
  apiMode: 'personal',
  canDelegate: false,
  version: '0.38.0',
} as const;

function entry(
  id: string,
  role: ConversationEntry['role'],
  text: string,
  finalized: boolean,
): ConversationEntry {
  return { id, role, text, finalized };
}

function toolEntry(
  id: string,
  status: NormalizedToolUse['status'],
  outputText = status === 'completed' ? 'ok' : '',
): ConversationEntry {
  return {
    id,
    role: 'tool',
    text: '',
    finalized: false,
    toolUse: {
      parsed: {},
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

function compactExecutionsEntry(id: string, path: string): ConversationEntry {
  return {
    id,
    role: 'tool',
    text: '',
    finalized: true,
    toolUse: {
      parsed: {},
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

describe('CLI conversation transcript splitting', () => {
  it('keeps only explicit finalized entries in scrollback', () => {
    const user = entry('u1', 'user', '1+1', true);
    const assistant = entry('a1', 'assistant', '2', false);

    const running = splitTranscriptEntries(
      [user, assistant],
      STREAM_STATUS.RUNNING,
    );
    expect(running.finalized).toEqual([user]);
    expect(running.pending).toEqual([assistant]);

    const waitingBeforeFinalize = splitTranscriptEntries(
      [user, assistant],
      STREAM_STATUS.WAITING,
    );
    expect(waitingBeforeFinalize.finalized).toEqual([user]);
    expect(waitingBeforeFinalize.pending).toEqual([]);
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

    finalizeAssistantTranscriptEntries(STREAM_ID);

    const slice = cliState.streams.get().get(STREAM_ID);
    expect(slice?.entries.map((item) => item.finalized)).toEqual([true, true]);
    const split = splitTranscriptEntries(
      slice?.entries ?? [],
      STREAM_STATUS.WAITING,
    );
    expect(split.finalized.map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(split.pending).toEqual([]);
  });

  it('freezes assistant entries when a stream returns to ready', () => {
    resetCliState();
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [entry('a1', 'assistant', 'A final answer.', false)],
    }));
    const dispose = subscribeStreamStatus();

    try {
      StreamStatusService.set(STREAM_ID, STREAM_STATUS.READY, {
        runtimeHost: { emit: () => undefined },
      });

      expect(
        cliState.streams
          .get()
          .get(STREAM_ID)
          ?.entries.map((item) => ({
            id: item.id,
            finalized: item.finalized,
          })),
      ).toEqual([{ id: 'a1', finalized: true }]);
    } finally {
      dispose();
    }
  });

  // Regression: a stream reused for a new run still carries WAITING from
  // the prior turn. The status must flip to a non-final value before
  // syncStreamLog derives finalizeDeferred, otherwise the next run's
  // in-flight entries get finalized early and lose later chunks.
  it('clears a stale final status before the next run streams', () => {
    resetCliState();
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      status: STREAM_STATUS.WAITING,
    }));
    const dispose = subscribeStreamStatus();

    try {
      StreamStatusService.set(STREAM_ID, STREAM_STATUS.RUNNING, {
        runtimeHost: { emit: () => undefined },
      });

      expect(cliState.streams.get().get(STREAM_ID)?.status).toBe(
        STREAM_STATUS.RUNNING,
      );
    } finally {
      dispose();
    }
  });

  // Regression: pending tool rows must render after preceding live
  // assistant text, not before. The previous renderer used a separate
  // `pendingTools` bucket that always sat above the live region, so a
  // model emitting prose before a tool call appeared as
  // user → tool → assistant text on screen.
  it('keeps pending entries in stream order so tool rows trail prior text', () => {
    const user = entry('u1', 'user', 'do a thing', true);
    const assistant = entry('a1', 'assistant', 'sure, running…', false);
    const tool = toolEntry('t1', 'in_progress');

    const split = splitTranscriptEntries(
      [user, assistant, tool],
      STREAM_STATUS.RUNNING,
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
      cliState.streams.get().get(STREAM_ID)?.entries ?? [],
      STREAM_STATUS.RUNNING,
    );
    expect(split.finalized).toHaveLength(0);
    expect(split.pending.map((e) => e.id)).toEqual(['a1', 't1']);

    finalizeAssistantTranscriptEntries(STREAM_ID);

    split = splitTranscriptEntries(
      cliState.streams.get().get(STREAM_ID)?.entries ?? [],
      STREAM_STATUS.WAITING,
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

  it('can size finalized scoped assistant history with the full markdown estimator', () => {
    const assistant = entry(
      'a1',
      'assistant',
      Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'),
      true,
    );

    const liveRows = estimateLiveTranscriptEntryRows(assistant, 80);
    const fullRows = estimateTranscriptEntryRows(assistant, 80);
    const selected = selectTranscriptEntriesForViewport(
      [assistant],
      fullRows,
      80,
      'finalized-full',
    );

    expect(liveRows).toBeLessThan(fullRows);
    expect(selected.entries.map((item) => item.id)).toEqual(['a1']);
    expect(selected.usedRows).toBe(fullRows);
    expect(selected.rowLimits.has('a1')).toBe(false);
  });

  it('renders bounded finalized assistant tails through markdown', () => {
    const text = ['intro line', 'middle line', '**bold tail marker**'].join(
      '\n',
    );

    const finalizedTail = boundedAssistantDisplayLines({
      colorEnabled: false,
      finalized: true,
      rows: 1,
      text,
      width: 80,
    }).join('\n');
    const streamingTail = boundedAssistantDisplayLines({
      colorEnabled: false,
      finalized: false,
      rows: 1,
      text,
      width: 80,
    }).join('\n');

    expect(finalizedTail).toContain('bold tail marker');
    expect(finalizedTail).not.toContain('**bold tail marker**');
    expect(streamingTail).toContain('**bold tail marker**');
  });

  it('pads compact prefixed rows to the viewport width', () => {
    expect(
      compactPrefixedDisplayRows({
        fillWidth: true,
        prefix: '! ',
        text: 'bad',
        width: 8,
      }),
    ).toBe('! bad   ');
    expect(
      compactPrefixedDisplayRows({
        fillWidth: true,
        maxRows: 1,
        prefix: '! ',
        text: 'abcdef',
        width: 6,
      }),
    ).toBe('  ef  ');
  });

  it('appends only finalized entries to terminal scrollback items', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', false);

    const first = appendStaticTranscriptItems({
      activeStreamId: STREAM_ID,
      currentItems: [],
      streams: streamsFromEntries(STREAM_ID, [user, assistant]),
      meta: SESSION_META,
    });
    expect(first).toHaveLength(2);
    expect(first[0]?.kind).toBe('header');
    expect(first.slice(1).map((item) => item.id)).toEqual(['u1']);

    const second = appendStaticTranscriptItems({
      activeStreamId: STREAM_ID,
      currentItems: first,
      streams: streamsFromEntries(STREAM_ID, [
        user,
        { ...assistant, finalized: true },
      ]),
      meta: SESSION_META,
    });
    expect(second).toHaveLength(3);
    expect(second.slice(1).map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('shows the session header exactly once', () => {
    const first = appendStaticTranscriptItems({
      activeStreamId: undefined,
      currentItems: [],
      streams: new Map(),
      meta: SESSION_META,
    });
    expect(first).toHaveLength(1);

    const again = appendStaticTranscriptItems({
      activeStreamId: undefined,
      currentItems: first,
      streams: new Map(),
      meta: { ...SESSION_META, model: 'sonnet' },
    });
    expect(again).toHaveLength(1);
  });

  it('uses a compact header but preserves static transcript entries for short terminal layouts', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', true);

    const compact = appendStaticTranscriptItems({
      activeStreamId: STREAM_ID,
      currentItems: [],
      streams: streamsFromEntries(STREAM_ID, [user, assistant]),
      meta: SESSION_META,
      maxRows: 2,
      width: 80,
    });

    expect(compact).toHaveLength(3);
    expect(compact[0]).toMatchObject({
      id: 'session-header',
      kind: 'header',
      compact: true,
    });
    expect(compact.slice(1).map((item) => item.id)).toEqual(['u1', 'a1']);

    expect(
      appendStaticTranscriptItems({
        activeStreamId: STREAM_ID,
        currentItems: [],
        streams: streamsFromEntries(STREAM_ID, [user, assistant]),
        meta: SESSION_META,
        maxRows: 0,
        width: 80,
      }).map((item) => item.id),
    ).toEqual(['u1', 'a1']);
  });

  it('preserves static transcript order when an entry exceeds the compact row budget', () => {
    const first = entry('u1', 'user', 'first', true);
    const large = entry('a1', 'assistant', 'line 1\nline 2\nline 3', true);
    const later = entry('u2', 'user', 'later', true);

    const compact = appendStaticTranscriptItems({
      activeStreamId: STREAM_ID,
      currentItems: [],
      streams: streamsFromEntries(STREAM_ID, [first, large, later]),
      meta: SESSION_META,
      maxRows: 2,
      width: 80,
    });

    expect(compact.map((item) => item.id)).toEqual([
      'session-header',
      'u1',
      'a1',
      'u2',
    ]);
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

  it('only feeds the active stream into scrollback, not background subagents', () => {
    const rootUser = entry('u1', 'user', 'do x', true);
    const childAssistant = entry('a1', 'assistant', 'done', true);
    const ROOT = 'root-stream' as StreamTabId;
    const CHILD = 'claude@agent-sdk#1' as StreamTabId;
    const streams = new Map<StreamTabId, StreamSlice>([
      [ROOT, sliceWithEntries(ROOT, [rootUser])],
      [CHILD, sliceWithEntries(CHILD, [childAssistant])],
    ]);

    const items = appendStaticTranscriptItems({
      activeStreamId: ROOT,
      currentItems: [],
      streams,
      meta: SESSION_META,
    });

    expect(items.slice(1).map((item) => item.id)).toEqual(['u1']);
  });

  it('separates root scrollback from scoped child transcript viewports', () => {
    const ROOT = 'root-stream' as StreamTabId;
    const CHILD = 'claude@agent-sdk#1' as StreamTabId;
    const parentStream = new Map<StreamTabId, StreamTabId>([[CHILD, ROOT]]);
    const rootViewportKey = transcriptViewportKey({
      activeStreamId: ROOT,
      parentStream,
    });
    const childViewportKey = transcriptViewportKey({
      activeStreamId: CHILD,
      parentStream,
    });

    expect(rootViewportKey).toBe('root-scrollback');
    expect(childViewportKey).toBe(`scoped:${CHILD}`);
    expect(
      transcriptViewportChange({
        previousViewportKey: rootViewportKey,
        nextViewportKey: childViewportKey,
      }),
    ).toMatchObject({ enteredRootScrollback: false });
    expect(
      transcriptViewportChange({
        previousViewportKey: childViewportKey,
        nextViewportKey: rootViewportKey,
      }),
    ).toMatchObject({ enteredRootScrollback: true });
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

  it('compacts adjacent one-line tool rows in the transcript viewer', () => {
    const lines = transcriptToLines(
      sliceWithEntries(STREAM_ID, [
        compactExecutionsEntry('t1', '/executions/3a780a389327/report'),
        compactExecutionsEntry('t2', '/executions/3a780a389327/conversation'),
      ]),
      80,
    );

    expect(lines).toEqual([
      '● executions (/executions/3a780a389327/report)',
      '● executions (/executions/3a780a389327/conversation)',
    ]);
  });

  it('keeps transcript viewer separators around prose and detailed tool rows', () => {
    const lines = transcriptToLines(
      sliceWithEntries(STREAM_ID, [
        compactExecutionsEntry('t1', '/executions/3a780a389327/report'),
        entry('a1', 'assistant', 'Read the report.', true),
        toolEntry('t2', 'completed'),
      ]),
      80,
    );

    expect(lines).toEqual([
      '● executions (/executions/3a780a389327/report)',
      '',
      'Read the report.',
      '',
      '● Bash (ls)',
      '⎿ ok',
    ]);
  });

  it('wraps wide tool output lines in the transcript viewer', () => {
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
});

function sliceWithEntries(
  streamId: StreamTabId,
  entries: readonly ConversationEntry[],
): StreamSlice {
  return {
    streamId,
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    usage: undefined,
    conversation: undefined,
    entries,
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: { bash: false, toolEdit: false, superYolo: false },
  };
}

function streamsFromEntries(
  streamId: StreamTabId,
  entries: readonly ConversationEntry[],
): ReadonlyMap<StreamTabId, StreamSlice> {
  return new Map([[streamId, sliceWithEntries(streamId, entries)]]);
}
