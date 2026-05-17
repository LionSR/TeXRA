import { describe, expect, it } from 'vitest';

import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

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
});
