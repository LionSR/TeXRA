// Third-party imports
import { create } from 'mutative';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  hostBridge: {
    getState: () => undefined,
    setState: mocks.setState,
  },
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
  fingerprintFollowUpImage,
  getFollowUpInputTransientState,
} from '@progressView/frontend/followUpInputState';
import { followUpHandlers } from '@progressView/frontend/slices/followUpSlice';
import { streamLifecycleHandlers } from '@progressView/frontend/slices/streamLifecycleSlice';
import {
  createInitialState,
  isToolUseState,
  type ProgressState,
  type StreamState,
} from '@progressView/frontend/store';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  createStreamState,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type StreamTabId,
} from '@shared/schemas';

function createToolUseState(text: string): StreamState {
  const state = createStreamState(AgentCategory.ToolUse);
  if (!isToolUseState(state)) throw new Error('Expected tool-use state');
  return create(state, (draft) => {
    draft.status = STREAM_PHASE.RUNNING;
    draft.userFollowUpSupport = USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE;
    draft.ui.followUpText = text;
  });
}

/** Seed two supported streams while stream B owns visible focus. */
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
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      creationTimestamp: 1,
    });
  }
  appState.set(state);
  return () => appState.get();
}

function toolUseState(state: ProgressState, streamId: string) {
  const stream = state.streamStates.get(streamId);
  if (!stream || !isToolUseState(stream)) {
    throw new Error(`Expected tool-use state for ${streamId}`);
  }
  return stream;
}

function send(
  streamId = 'stream-a',
  images: Array<{ fileName: string; base64: string; mediaType: string }> = [],
): void {
  handleFollowUpSend({
    detail: { streamId, images },
  } as CustomEvent);
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
        value: '[pasted_a.png]',
        mode: 'append',
      },
    } as CustomEvent);

    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe(
      'draft [pasted_a.png]',
    );
    expect(toolUseState(getState(), 'stream-b').ui.followUpText).toBe('other');
  });

  it('routes the source stream while another stream has focus and waits for acceptance', () => {
    const getState = seedState();
    handleFollowUpChange({
      detail: {
        streamId: 'stream-a',
        value: 'draft [pasted_a.png]',
      },
    } as CustomEvent);
    const pastedImage = {
      fileName: 'pasted_a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };

    handleFollowUpSend({
      detail: { streamId: 'stream-a', images: [pastedImage] },
    } as CustomEvent);

    expect(mocks.postMessage).toHaveBeenCalledWith(
      PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
      {
        stream: 'stream-a',
        text: 'draft [pasted_a.png]',
        deliveryId: expect.any(String),
        images: [pastedImage],
      },
    );
    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe(
      'draft [pasted_a.png]',
    );
    expect(toolUseState(getState(), 'stream-b').ui.followUpText).toBe('other');
  });

  it('prevents duplicate sends while delivery is in flight', () => {
    seedState();

    send();
    send();

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
  });

  it('makes a storage failure retryable instead of posting or staying sending', () => {
    const getState = seedState();
    mocks.setState.mockImplementationOnce(() => {
      throw new Error('quota');
    });

    send();

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(toolUseState(getState(), 'stream-a').ui.followUpSubmission).toEqual(
      expect.objectContaining({
        status: 'failed',
        error:
          'The follow-up could not be saved in this window. Free storage or reload TeXRA, then try again.',
      }),
    );
  });

  it('preserves a failed draft and retries with the same delivery id', () => {
    const getState = seedState();
    send();
    const deliveryId = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission?.deliveryId;
    if (!deliveryId) throw new Error('Expected pending delivery');

    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId,
      accepted: false,
      error: 'Unable to send. Check your connection and try again.',
    });

    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe('draft');
    expect(toolUseState(getState(), 'stream-a').ui.followUpSubmission).toEqual({
      status: 'failed',
      deliveryId,
      text: 'draft',
      attachmentFingerprints: [],
      error: 'Unable to send. Check your connection and try again.',
    });

    send();
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
      expect.objectContaining({ deliveryId }),
    );
  });

  it('retains text and images after an image-save rejection', () => {
    const getState = seedState();
    const image = {
      fileName: 'pasted_a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };
    const transientState = getFollowUpInputTransientState('stream-a');
    transientState.pendingImages = [image];
    handleFollowUpChange({
      detail: { streamId: 'stream-a', value: 'draft [pasted_a.png]' },
    } as CustomEvent);
    send('stream-a', [image]);
    const deliveryId = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission?.deliveryId;
    if (!deliveryId) throw new Error('Expected pending delivery');

    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId,
      accepted: false,
      error:
        'An image could not be saved. Remove and paste the images again, then try again.',
    });

    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe(
      'draft [pasted_a.png]',
    );
    expect(transientState.pendingImages).toEqual([image]);
  });

  it('uses a new delivery id when failed-retry attachments change', () => {
    const getState = seedState();
    const firstImage = {
      fileName: 'pasted_a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };
    handleFollowUpChange({
      detail: { streamId: 'stream-a', value: 'draft [pasted_a.png]' },
    } as CustomEvent);
    send('stream-a', [firstImage]);
    const firstSubmission = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission;
    if (!firstSubmission) throw new Error('Expected pending delivery');
    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId: firstSubmission.deliveryId,
      accepted: false,
      error: 'Try again.',
    });

    const changedImage = { ...firstImage, base64: 'BBBB' };
    send('stream-a', [changedImage]);

    const retry = toolUseState(getState(), 'stream-a').ui.followUpSubmission;
    expect(retry?.deliveryId).not.toBe(firstSubmission.deliveryId);
    expect(retry?.attachmentFingerprints).toEqual([
      fingerprintFollowUpImage(changedImage),
    ]);
  });

  it('clears only the accepted attachment snapshot after async draft changes', () => {
    const getState = seedState();
    const sentImage = {
      fileName: 'pasted_a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };
    const newImage = {
      fileName: 'pasted_b.png',
      base64: 'BBBB',
      mediaType: 'image/png',
    };
    const transientState = getFollowUpInputTransientState('stream-a');
    transientState.pendingImages = [sentImage];
    handleFollowUpChange({
      detail: { streamId: 'stream-a', value: 'draft [pasted_a.png]' },
    } as CustomEvent);
    send('stream-a', transientState.pendingImages);
    const submission = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission;
    if (!submission) throw new Error('Expected pending delivery');

    transientState.pendingImages = [sentImage, newImage];
    handleFollowUpChange({
      detail: {
        streamId: 'stream-a',
        value: 'new draft [pasted_b.png]',
      },
    } as CustomEvent);
    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId: submission.deliveryId,
      accepted: true,
    });

    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe(
      'new draft [pasted_b.png]',
    );
    expect(transientState.pendingImages).toEqual([newImage]);
  });

  it('preserves matching text when its attachment changed during delivery', () => {
    const getState = seedState();
    const sentImage = {
      fileName: 'pasted_a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };
    const changedImage = { ...sentImage, base64: 'BBBB' };
    const transientState = getFollowUpInputTransientState('stream-a');
    transientState.pendingImages = [sentImage];
    handleFollowUpChange({
      detail: { streamId: 'stream-a', value: 'draft [pasted_a.png]' },
    } as CustomEvent);
    send('stream-a', transientState.pendingImages);
    const deliveryId = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission?.deliveryId;
    if (!deliveryId) throw new Error('Expected pending delivery');

    transientState.pendingImages = [changedImage];
    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId,
      accepted: true,
    });

    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe(
      'draft [pasted_a.png]',
    );
    expect(transientState.pendingImages).toEqual([changedImage]);
  });

  it('clears only the accepted stream draft and ignores stale replay', () => {
    const getState = seedState();
    send();
    const deliveryId = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission?.deliveryId;
    if (!deliveryId) throw new Error('Expected pending delivery');

    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId: 'stale-delivery',
      accepted: true,
    });
    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe('draft');

    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]({
      command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
      stream: 'stream-a',
      deliveryId,
      accepted: true,
    });
    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe('');
    expect(toolUseState(getState(), 'stream-b').ui.followUpText).toBe('other');
  });

  it('keeps delivery in flight across ordinary structural state refreshes', () => {
    const getState = seedState();
    send();
    const streamInfo = getState().streamById.get('stream-a');
    const otherStreamInfo = getState().streamById.get('stream-b');
    if (!streamInfo || !otherStreamInfo)
      throw new Error('Expected stream info');

    streamLifecycleHandlers[PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams: [streamInfo, otherStreamInfo],
      activeStream: 'stream-a',
      streamStates: {
        'stream-a': {
          category: AgentCategory.ToolUse,
          status: STREAM_PHASE.WAITING,
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
          conversationProgress: { toolCallCount: 1 },
          subagents: [],
        },
      },
    });

    expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe('draft');
    expect(toolUseState(getState(), 'stream-a').ui.followUpSubmission).toEqual(
      expect.objectContaining({ status: 'sending' }),
    );
    send();
    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
  });

  it('makes an unresolved delivery retryable on explicit transport restore', () => {
    const getState = seedState();
    const image = {
      fileName: 'pasted_a.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };
    handleFollowUpChange({
      detail: { streamId: 'stream-a', value: 'draft [pasted_a.png]' },
    } as CustomEvent);
    send('stream-a', [image]);
    const deliveryId = toolUseState(getState(), 'stream-a').ui
      .followUpSubmission?.deliveryId;

    followUpHandlers[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TRANSPORT_RESTORED]();

    expect(toolUseState(getState(), 'stream-a').ui.followUpSubmission).toEqual(
      expect.objectContaining({
        status: 'failed',
        deliveryId,
        error: 'Delivery status was not confirmed. Try again.',
      }),
    );
    send('stream-a', [image]);
    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
      expect.objectContaining({ deliveryId, images: [image] }),
    );
  });

  it.each([
    [
      'unsupported',
      USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      STREAM_PHASE.RUNNING,
      'This run does not accept follow-up messages.',
    ],
    [
      'terminal',
      USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      STREAM_PHASE.COMPLETED,
      'This run has ended. Start a new agent task to continue.',
    ],
  ])(
    'rejects %s current metadata and preserves the draft',
    (_name, support, status, error) => {
      const getState = seedState();
      appState.set(
        create(appState.get(), (draft) => {
          const state = draft.streamStates.get('stream-a');
          if (state) {
            state.userFollowUpSupport = support;
            state.status = status;
          }
        }),
      );

      send();

      expect(mocks.postMessage).not.toHaveBeenCalled();
      expect(toolUseState(getState(), 'stream-a').ui.followUpText).toBe(
        'draft',
      );
      expect(
        toolUseState(getState(), 'stream-a').ui.followUpSubmission,
      ).toEqual(expect.objectContaining({ status: 'failed', error }));
    },
  );
});
