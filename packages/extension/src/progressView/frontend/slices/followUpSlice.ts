/**
 * Follow-up handlers: UPDATE_FOLLOW_UP_TEXT, UPDATE_RECORDING,
 * UPDATE_QUEUED_FOLLOW_UPS.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { appState } from '../progressState';
import { updateToolUseState } from '../stateUtils';

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
export const followUpHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT]: (data) => {
    const streamId =
      data.stream ??
      (data.kind === 'transcribed' ? appState.get().activeStreamId : null);
    if (!streamId) return;
    if (!appState.get().streamStates.has(streamId)) return;

    updateToolUseState(streamId, (prev) =>
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

  [PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING]: (data) => {
    const streamId = appState.get().activeStreamId;
    if (!streamId) return;
    updateToolUseState(streamId, (prev) =>
      create(prev, (draft) => {
        draft.ui.recording = data.status === 'started';
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: (data) => {
    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.queuedFollowUps = data.messages;
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
