import { describe, expect, it } from 'vitest';

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  type NormalizedToolUse,
  type StreamTabId,
} from '@shared/schemas';

import { splitTranscriptEntries } from '../../../packages/cli/src/chat/tui/panes/transcriptEntries';
import {
  appendStaticTranscriptItems,
  selectPendingEntriesForViewport,
} from '../../../packages/cli/src/chat/tui/panes/ConversationPane';
import {
  cliState,
  patchStream,
  resetCliState,
  type ConversationEntry,
  type StreamSlice,
} from '../../../packages/cli/src/chat/tui/state/cliState';
import { finalizeAssistantTranscriptEntries } from '../../../packages/cli/src/chat/tui/state/transcript';
import { subscribeStreamStatus } from '../../../packages/cli/src/chat/tui/state/subscribeStreamStatus';

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
      outputText: status === 'completed' ? 'ok' : '',
      userInstructionText: '',
      input: { command: 'ls' },
      isError: false,
      isUserFeedback: false,
      headerSummary: '',
      status,
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

    const selected = selectPendingEntriesForViewport([assistant], 4, 80);

    expect(selected.entries.map((item) => item.id)).toEqual(['a1']);
    expect(selected.usedRows).toBe(4);
    expect(selected.rowLimits.get('a1')).toBe(4);
  });

  it('appends only finalized entries to terminal scrollback items', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', false);

    const first = appendStaticTranscriptItems({
      currentItems: [],
      streams: streamsFromEntries(STREAM_ID, [user, assistant]),
      meta: SESSION_META,
    });
    expect(first).toHaveLength(2);
    expect(first[0]?.kind).toBe('header');
    expect(first.slice(1).map((item) => item.id)).toEqual([`${STREAM_ID}:u1`]);

    const second = appendStaticTranscriptItems({
      currentItems: first,
      streams: streamsFromEntries(STREAM_ID, [
        user,
        { ...assistant, finalized: true },
      ]),
      meta: SESSION_META,
    });
    expect(second).toHaveLength(3);
    expect(second.slice(1).map((item) => item.id)).toEqual([
      `${STREAM_ID}:u1`,
      `${STREAM_ID}:a1`,
    ]);
  });

  it('appends a fresh header block when session meta changes', () => {
    const first = appendStaticTranscriptItems({
      currentItems: [],
      streams: new Map(),
      meta: SESSION_META,
    });
    expect(first).toHaveLength(1);

    const switched = appendStaticTranscriptItems({
      currentItems: first,
      streams: new Map(),
      meta: { ...SESSION_META, model: 'sonnet' },
    });
    expect(switched).toHaveLength(2);
    expect(switched.every((item) => item.kind === 'header')).toBe(true);
  });

  it('appends finalized entries from background streams, not just active', () => {
    const rootUser = entry('u1', 'user', 'do x', true);
    const childAssistant = entry('a1', 'assistant', 'done', true);
    const ROOT = 'root-stream' as StreamTabId;
    const CHILD = 'claude@agent-sdk#1' as StreamTabId;

    const items = appendStaticTranscriptItems({
      currentItems: [],
      streams: new Map<StreamTabId, StreamSlice>([
        [ROOT, sliceWithEntries(ROOT, [rootUser])],
        [CHILD, sliceWithEntries(CHILD, [childAssistant])],
      ]),
      meta: SESSION_META,
    });

    expect(items.slice(1).map((item) => item.id)).toEqual([
      `${ROOT}:u1`,
      `${CHILD}:a1`,
    ]);
  });
});

function sliceWithEntries(
  streamId: StreamTabId,
  entries: readonly ConversationEntry[],
): StreamSlice {
  return {
    streamId,
    status: undefined,
    description: undefined,
    usage: undefined,
    conversation: undefined,
    entries,
    queuedFollowUps: 0,
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: { toolEdit: false, superYolo: false },
  };
}

function streamsFromEntries(
  streamId: StreamTabId,
  entries: readonly ConversationEntry[],
): ReadonlyMap<StreamTabId, StreamSlice> {
  return new Map([[streamId, sliceWithEntries(streamId, entries)]]);
}
