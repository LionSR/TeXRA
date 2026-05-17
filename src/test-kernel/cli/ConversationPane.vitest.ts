import { describe, expect, it } from 'vitest';

import {
  STREAM_STATUS,
  type NormalizedToolUse,
  type StreamTabId,
} from '@shared/schemas';

import { splitTranscriptEntries } from '../../../packages/cli/src/chat/tui/panes/transcriptEntries';
import {
  cliState,
  patchStream,
  resetCliState,
  type ConversationEntry,
} from '../../../packages/cli/src/chat/tui/state/cliState';
import { finalizeAssistantTranscriptEntries } from '../../../packages/cli/src/chat/tui/state/transcript';

const STREAM_ID = 'cli-test-stream' as StreamTabId;

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
    expect(running.live).toBe(assistant);

    const waitingBeforeFinalize = splitTranscriptEntries(
      [user, assistant],
      STREAM_STATUS.WAITING,
    );
    expect(waitingBeforeFinalize.finalized).toEqual([user]);
    expect(waitingBeforeFinalize.live).toBeUndefined();
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
    expect(split.live).toBeUndefined();
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
    expect(split.live?.id).toBe('a1');
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
});
