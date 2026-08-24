/**
 * Follow-up handlers: UPDATE_FOLLOW_UP_TEXT, UPDATE_RECORDING,
 * UPDATE_QUEUED_FOLLOW_UPS.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  persistFollowUpDraft,
  recoverInterruptedFollowUpSubmission,
} from '../followUpDraftPersistence';
import {
  followUpAttachmentFingerprintsMatch,
  followUpAttachmentSnapshot,
  getFollowUpInputTransientState,
  removeAcceptedFollowUpImages,
} from '../followUpInputState';
import { appState } from '../progressState';
import { updateToolUseState } from '../stateUtils';

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
    persistFollowUpDraft(streamId);
  },

  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TRANSPORT_RESTORED]: () => {
    const interrupted = [...appState.get().streamStates.entries()]
      .filter(
        ([, streamState]) =>
          'ui' in streamState &&
          streamState.ui.followUpSubmission?.status === 'sending',
      )
      .map(([streamId]) => streamId);
    appState.set(
      create(appState.get(), (draft) => {
        for (const streamId of interrupted) {
          const streamState = draft.streamStates.get(streamId);
          if (!streamState || !('ui' in streamState)) continue;
          const submission = streamState.ui.followUpSubmission;
          if (submission?.status !== 'sending') continue;
          streamState.ui.followUpSubmission =
            recoverInterruptedFollowUpSubmission(submission);
        }
      }),
    );
    for (const streamId of interrupted) persistFollowUpDraft(streamId);
  },

  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT]: (data) => {
    const streamState = appState.get().streamStates.get(data.stream);
    if (!streamState || !('ui' in streamState)) return;
    const submission = streamState.ui.followUpSubmission;
    if (!submission || submission.deliveryId !== data.deliveryId) return;
    const transientState = getFollowUpInputTransientState(data.stream);
    const currentText = streamState.ui.followUpText.trim();
    const currentAttachmentFingerprints = followUpAttachmentSnapshot(
      currentText,
      transientState.pendingImages,
    ).fingerprints;
    const draftStillMatches =
      currentText === submission.text &&
      followUpAttachmentFingerprintsMatch(
        currentAttachmentFingerprints,
        submission.attachmentFingerprints,
      );

    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        if (data.accepted) {
          if (draftStillMatches) {
            draft.ui.followUpText = '';
          }
          draft.ui.followUpSubmission = null;
          return;
        }
        draft.ui.followUpSubmission = {
          ...submission,
          status: 'failed',
          error: data.error,
        };
      }),
    );
    if (data.accepted) {
      removeAcceptedFollowUpImages(
        transientState,
        submission.attachmentFingerprints,
      );
    }
    persistFollowUpDraft(data.stream);
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
