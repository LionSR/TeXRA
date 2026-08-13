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

// Local imports
import {
  handleFollowUpChange,
  handleFollowUpSend,
} from '@progressView/frontend/eventHandlers';
import {
  appState,
  resetProgressState,
} from '@progressView/frontend/progressState';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  createStreamState,
  isToolUseState,
  type StreamState,
  type StreamTabId,
} from '@shared/schemas';

function createToolUseState(text: string): StreamState {
  const state = createStreamState(AgentCategory.ToolUse);
  if (!isToolUseState(state)) throw new Error('Expected tool-use state');
  return create(state, (draft) => {
    draft.ui.followUpText = text;
  });
}

/**
 * Seed the shared appState singleton with two tool-use streams and return a
 * live reader over it. Streams are registered in `streamById` too, so the
 * real `setStreamStateForId` mutator accepts updates for them.
 */
function seedState(): () => ProgressState {
  const state = createInitialState();
  state.activeStreamId = 'stream-b';
  for (const [streamId, text] of [
    ['stream-a', 'draft'],
    ['stream-b', 'other'],
  ] as const) {
    state.streamStates.set(streamId, createToolUseState(text));
    state.streamById.set(streamId, {
      name: streamId as StreamTabId,
      label: streamId,
      agentCategory: AgentCategory.ToolUse,
      creationTimestamp: 1,
    });
  }
  appState.set(state);
  return () => appState.get();
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
    resetProgressState();
  });

  it('appends a late paste token to its source stream', () => {
    const getState = seedState();

    handleFollowUpChange({
      detail: {
        streamId: 'stream-a',
        value: '[pasted-a.png]',
        mode: 'append',
      },
    } as CustomEvent);

    expect(followUpText(getState(), 'stream-a')).toBe('draft [pasted-a.png]');
    expect(followUpText(getState(), 'stream-b')).toBe('other');
  });

  it('sends stream A images while stream B is active', () => {
    const getState = seedState();
    handleFollowUpChange({
      detail: {
        streamId: 'stream-a',
        value: 'draft [pasted-a.png]',
      },
    } as CustomEvent);
    const pastedImage = {
      fileName: 'pasted-a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };

    handleFollowUpSend({
      detail: {
        streamId: 'stream-a',
        images: [pastedImage],
      },
    } as CustomEvent);

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
