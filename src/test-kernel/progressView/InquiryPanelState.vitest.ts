// Third-party imports
import { create } from 'mutative';
import { describe, expect, it } from 'vitest';

// Local imports - common webview
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view frontend
import { inquiryHandlers } from '@progressView/frontend/slices/inquirySlice';
import {
  createInitialState,
  type ProgressState,
  type StreamLogs,
} from '@progressView/frontend/store';
import type { MessageHandlerContext } from '@progressView/frontend/messageDispatcher';

// Local imports - shared schemas
import type {
  ExternalInquiryThreadId,
  InquiryThreadUpdatedEvent,
  ProgressViewOutboundMessage,
  StreamTabId,
} from '@shared/schemas';

function createContext(initialState: ProgressState): {
  ctx: MessageHandlerContext;
  getState: () => ProgressState;
} {
  let state = initialState;
  const ctx: MessageHandlerContext = {
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    setStreamState: (streamId, updater) => {
      const current = state.streamStates.get(streamId);
      if (!current) return;
      const updated = updater(current);
      if (updated === current) return;
      state = create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      });
    },
    setStreamLogs: (
      _streamId,
      _updater: (prev: StreamLogs) => StreamLogs,
    ) => {},
    savePrefs: () => {},
    getPermissions: () => [],
    setPermissions: () => {},
    setPlacement: () => {},
  };
  return { ctx, getState: () => state };
}

function thread(
  threadId: string,
  parentStreamId: string | null,
  status: InquiryThreadUpdatedEvent['status'],
): InquiryThreadUpdatedEvent {
  return {
    threadId: threadId as ExternalInquiryThreadId,
    parentStreamId: parentStreamId as StreamTabId | null,
    status,
    lastQuestionPreview: `Question for ${threadId}`,
    lastActivityIso: '2026-05-16T12:00:00.000Z',
    turnCount: 1,
  };
}

function dispatch(
  message: ProgressViewOutboundMessage,
  ctx: MessageHandlerContext,
) {
  const handler = inquiryHandlers[message.command];
  expect(handler).toBeDefined();
  handler?.(message as never, ctx);
}

describe('inquiry panel frontend state', () => {
  it('hydrates durable inquiry summaries', () => {
    const { ctx, getState } = createContext(createInitialState());

    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
        threads: [
          thread('ei_aabbccdd0011', 'stream-a', 'open'),
          thread('ei_aabbccdd0012', 'stream-a', 'answered'),
        ],
      },
      ctx,
    );

    expect(getState().inquiries.size).toBe(2);
    expect(getState().inquiries.get('ei_aabbccdd0011')).toMatchObject({
      status: 'open',
      parentStreamId: 'stream-a',
    });
  });

  it('does not retain ownerless thread summaries in panel state', () => {
    const { ctx, getState } = createContext(createInitialState());

    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
        threads: [
          thread('ei_aabbccdd0011', null, 'answered'),
          thread('ei_aabbccdd0012', 'stream-a', 'open'),
        ],
      },
      ctx,
    );
    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
        thread: thread('ei_aabbccdd0013', null, 'answered'),
      },
      ctx,
    );

    expect(getState().inquiries.has('ei_aabbccdd0011')).toBe(false);
    expect(getState().inquiries.has('ei_aabbccdd0012')).toBe(true);
    expect(getState().inquiries.has('ei_aabbccdd0013')).toBe(false);
  });

  it('replaces stale hydrated summaries and accepts incremental updates', () => {
    const state = createInitialState();
    state.inquiries.set(
      'ei_stale000000' as ExternalInquiryThreadId,
      thread('ei_stale000000', 'stream-a', 'open'),
    );
    const { ctx, getState } = createContext(state);

    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS,
        threads: [thread('ei_aabbccdd0011', 'stream-a', 'open')],
      },
      ctx,
    );
    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
        thread: thread('ei_aabbccdd0011', 'stream-a', 'answered'),
      },
      ctx,
    );

    expect(getState().inquiries.has('ei_stale000000')).toBe(false);
    expect(getState().inquiries.get('ei_aabbccdd0011')?.status).toBe(
      'answered',
    );
  });
});
