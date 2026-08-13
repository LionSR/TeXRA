// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports - progress view frontend
import { inquiryHandlers } from '@progressView/frontend/slices/inquirySlice';
import {
  appState,
  resetProgressState,
} from '@progressView/frontend/progressState';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  InquiryThreadId,
  InquiryThreadUpdatedEvent,
  ProgressViewOutboundHandlerRegistry,
  ProgressViewOutboundMessage,
  StreamTabId,
} from '@shared/schemas';
import { assertSupported } from '@shared/utils/dispatcher';

/** Seed the shared appState singleton and return a live reader over it. */
function seedState(initialState: ProgressState): () => ProgressState {
  appState.set(initialState);
  return () => appState.get();
}

function thread(
  threadId: string,
  parentStreamId: string | null,
  status: InquiryThreadUpdatedEvent['status'],
): InquiryThreadUpdatedEvent {
  return {
    threadId: threadId as InquiryThreadId,
    parentStreamId: parentStreamId as StreamTabId | null,
    status,
    lastQuestionPreview: `Question for ${threadId}`,
    lastActivityIso: '2026-05-16T12:00:00.000Z',
    turnCount: 1,
  };
}

function dispatch(message: ProgressViewOutboundMessage) {
  const handler = (
    inquiryHandlers as Partial<ProgressViewOutboundHandlerRegistry>
  )[message.command];
  expect(handler).toBeDefined();
  assertSupported(handler!)(message as never);
}

describe('inquiry panel frontend state', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('hydrates durable inquiry summaries', () => {
    const getState = seedState(createInitialState());

    dispatch({
      command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
      threads: [
        thread('ei_aabbccdd0011', 'stream-a', 'open'),
        thread('ei_aabbccdd0012', 'stream-a', 'answered'),
      ],
    });

    expect(getState().inquiries.size).toBe(2);
    expect(getState().inquiries.get('ei_aabbccdd0011')).toMatchObject({
      status: 'open',
      parentStreamId: 'stream-a',
    });
  });

  it('does not retain ownerless thread summaries in panel state', () => {
    const getState = seedState(createInitialState());

    dispatch({
      command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
      threads: [
        thread('ei_aabbccdd0011', null, 'answered'),
        thread('ei_aabbccdd0012', 'stream-a', 'open'),
      ],
    });
    dispatch({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
      thread: thread('ei_aabbccdd0013', null, 'answered'),
    });

    expect(getState().inquiries.has('ei_aabbccdd0011')).toBe(false);
    expect(getState().inquiries.has('ei_aabbccdd0012')).toBe(true);
    expect(getState().inquiries.has('ei_aabbccdd0013')).toBe(false);
  });

  it('replaces stale hydrated summaries and accepts incremental updates', () => {
    const state = createInitialState();
    state.inquiries.set(
      'ei_stale000000' as InquiryThreadId,
      thread('ei_stale000000', 'stream-a', 'open'),
    );
    const getState = seedState(state);

    dispatch({
      command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
      threads: [thread('ei_aabbccdd0011', 'stream-a', 'open')],
    });
    dispatch({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
      thread: thread('ei_aabbccdd0011', 'stream-a', 'answered'),
    });

    expect(getState().inquiries.has('ei_stale000000')).toBe(false);
    expect(getState().inquiries.get('ei_aabbccdd0011')?.status).toBe(
      'answered',
    );
  });
});
