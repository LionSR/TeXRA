// Third-party imports
import { create } from 'mutative';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

vi.mock('@progressView/frontend/components/ExternalInquiryPanel', () => ({
  clearInquiryDraft: vi.fn(),
}));

// Local imports - progress view
import {
  handleFollowUpChange,
  handleFollowUpSend,
} from '@progressView/frontend/eventHandlers';
import type { FrontendEventHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  createInitialState,
  isToolUseState,
  type ProgressState,
  type StreamState,
} from '@progressView/frontend/store';

// Local imports - shared schemas
import {
  AgentCategory,
  createStreamState,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

function createToolUseState(text: string): StreamState {
  const state = createStreamState(AgentCategory.ToolUse);
  if (!isToolUseState(state)) throw new Error('Expected tool-use state');
  return create(state, (draft) => {
    draft.ui.followUpText = text;
  });
}

function createContext(): {
  ctx: FrontendEventHandlerContext;
  getState: () => ProgressState;
} {
  let state = createInitialState();
  state.activeStreamId = 'stream-b';
  state.streamStates.set('stream-a', createToolUseState('draft'));
  state.streamStates.set('stream-b', createToolUseState('other'));

  const ctx: FrontendEventHandlerContext = {
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    setStreamState: (
      streamId: StreamTabId,
      updater: (prev: StreamState) => StreamState,
    ) => {
      const current = state.streamStates.get(streamId);
      if (!current) return;
      const updated = updater(current);
      state = create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      });
    },
    setStreamLogs: () => {},
  };

  return { ctx, getState: () => state };
}

function followUpText(state: ProgressState, streamId: string): string {
  const stream = state.streamStates.get(streamId);
  if (!stream || !isToolUseState(stream)) {
    throw new Error(`Expected tool-use state for ${streamId}`);
  }
  return stream.ui.followUpText;
}

describe('stream-scoped follow-up event handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a late paste token to its source stream', () => {
    const { ctx, getState } = createContext();

    handleFollowUpChange(
      {
        detail: {
          streamId: 'stream-a',
          value: '[pasted-a.png]',
          mode: 'append',
        },
      } as CustomEvent,
      ctx,
    );

    expect(followUpText(getState(), 'stream-a')).toBe('draft [pasted-a.png]');
    expect(followUpText(getState(), 'stream-b')).toBe('other');
  });

  it('sends stream A images while stream B is active', () => {
    const { ctx, getState } = createContext();
    handleFollowUpChange(
      {
        detail: {
          streamId: 'stream-a',
          value: 'draft [pasted-a.png]',
        },
      } as CustomEvent,
      ctx,
    );
    const pastedImage = {
      fileName: 'pasted-a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };

    handleFollowUpSend(
      {
        detail: {
          streamId: 'stream-a',
          images: [pastedImage],
        },
      } as CustomEvent,
      ctx,
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
      {
        stream: 'stream-a',
        text: 'draft [pasted-a.png]',
        images: [pastedImage],
      },
    );
    expect(followUpText(getState(), 'stream-a')).toBe('');
    expect(followUpText(getState(), 'stream-b')).toBe('other');
  });
});
