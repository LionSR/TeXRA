/**
 * Follow-up handlers: UPDATE_FOLLOW_UP_TEXT, UPDATE_RECORDING,
 * UPDATE_QUEUED_FOLLOW_UPS.
 *
 * Owns setActiveStreamRecording helper.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { appState } from '../progressState';
import { updateToolUseState } from '../stateUtils';

// ============================================================
// Helpers
// ============================================================

function setActiveStreamRecording(recording: boolean): void {
  const streamId = appState.get().activeStreamId;
  if (!streamId) return;
  updateToolUseState(streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.recording = recording;
    }),
  );
}

// ============================================================
// Handlers
// ============================================================

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
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

  [PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING]: (data) =>
    setActiveStreamRecording(data.status === 'started'),

  [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: (data) => {
    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.queuedFollowUps = data.messages;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS]: (data) => {
    if (!appState.get().streamStates.has(data.stream)) return;

    appState.set(
      create(appState.get(), (draft) => {
        draft.followupOptionsByStream.set(data.stream, {
          toolUseAgentsData: data.toolUseAgentsData,
          modelOptionsData: data.modelOptionsData,
        });
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
