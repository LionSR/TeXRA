/**
 * Follow-up handlers: UPDATE_FOLLOW_UP_TEXT, SET_FOLLOWUP_OPTIONS,
 * UPDATE_RECORDING, UPDATE_QUEUED_FOLLOW_UPS.
 *
 * Owns setActiveStreamRecording helper.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import { updateToolUseState } from '../stateUtils';
import type {
  HandlerRegistry,
  MessageHandlerContext,
} from '../messageDispatcher';

// ============================================================
// Helpers
// ============================================================

function setActiveStreamRecording(
  ctx: MessageHandlerContext,
  recording: boolean,
): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  updateToolUseState(ctx, streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.recording = recording;
    }),
  );
}

// ============================================================
// Handlers
// ============================================================

export const followUpHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT]: (data, ctx) => {
    const streamId =
      data.stream ??
      (data.kind === 'transcribed' ? ctx.getState().activeStreamId : null);
    if (!streamId) return;
    if (!ctx.getState().streamStates.has(streamId)) return;

    updateToolUseState(ctx, streamId, (prev) =>
      create(prev, (draft) => {
        switch (data.kind) {
          case 'polished':
            if (!data.text) return;
            draft.ui.followUpText = data.text;
            draft.ui.polishedText = data.text;
            draft.ui.polishRevision += 1;
            draft.ui.shouldFocusFollowUp = true;
            break;
          case 'polishError':
            draft.ui.polishedText = prev.ui.followUpText;
            draft.ui.polishRevision += 1;
            draft.ui.shouldFocusFollowUp = true;
            break;
          case 'transcribed':
            if (!data.text) return;
            draft.ui.transcribedText = data.text;
            draft.ui.shouldFocusFollowUp = true;
            break;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING]: (data, ctx) =>
    setActiveStreamRecording(ctx, data.status === 'started'),

  [PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS]: (data, ctx) => {
    const { command: _command, stream, ...options } = data;
    if (!stream) {
      console.warn('SET_FOLLOWUP_OPTIONS missing stream ID.', { data });
      return;
    }
    // Guard: ignore late-arriving messages for deleted streams
    if (!ctx.getState().streamStates.has(stream)) return;

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.followupOptionsByStream.set(stream, options);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.queuedFollowUps = data.messages;
      }),
    );
  },
};
