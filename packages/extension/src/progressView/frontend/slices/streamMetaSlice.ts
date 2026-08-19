/**
 * Stream metadata handlers: UPDATE_STREAM_STATUS, UPDATE_STREAM_DESCRIPTION,
 * UPDATE_CONVERSATION_PROGRESS, UPDATE_STREAM_BADGES.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  isToolUseState,
  STREAM_PHASE,
  type ProgressViewOutboundHandlerRegistry,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { isTranscriptSettlementPhase } from '@shared/streams/streamStatus';

import { settleCompactionActivityLogs } from './logSlice';
import { mergeBackendOwnedState } from './streamStateMerge';
import { appState, setStreamStateForId } from '../progressState';

function upsertSortedStreamInfo(
  streams: Map<StreamTabId, StreamTabInfo>,
  streamInfo: StreamTabInfo,
): Map<StreamTabId, StreamTabInfo> {
  const streamsWithoutPatch = [...streams.values()].filter(
    (stream) => stream.name !== streamInfo.name,
  );
  const ordered = [...streamsWithoutPatch, streamInfo].toSorted(
    compareByNewestCreationTime,
  );

  return new Map(ordered.map((stream) => [stream.name, stream]));
}

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
export const streamMetaHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA]: (data) => {
    const { streamInfo: rawInfo, streamState, activeStream } = data;
    const name = rawInfo.name;

    const prev = appState.get();
    const existingInfo = prev.streamById.get(name);
    const description = rawInfo.description ?? existingInfo?.description;
    const streamInfo =
      description !== rawInfo.description
        ? { ...rawInfo, description }
        : rawInfo;
    const mergedState = mergeBackendOwnedState(
      prev.streamStates.get(name),
      streamState,
    );

    appState.set(
      create(prev, (draft) => {
        if (
          !existingInfo ||
          existingInfo.creationTimestamp !== streamInfo.creationTimestamp
        ) {
          draft.streamById = upsertSortedStreamInfo(
            prev.streamById,
            streamInfo,
          );
        } else {
          draft.streamById.set(name, streamInfo);
        }

        // Metadata registration is followed by bridge replay. LOG_DELTA
        // settles only after applying that batch, so hydration cannot close
        // a start before its already-recorded outcome arrives.
        if (mergedState) draft.streamStates.set(name, mergedState);

        if (activeStream !== undefined) {
          draft.activeStreamId = activeStream || null;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: (data) => {
    const { stream, status, logHead, lastTimestamp, substate } = data;
    const previous = appState.get();
    const wasSettled = isTranscriptSettlementPhase(
      previous.streamStates.get(stream)?.status,
    );
    const shouldFocus =
      stream === previous.activeStreamId && status === STREAM_PHASE.WAITING;

    setStreamStateForId(stream, (current) =>
      create(current, (draft) => {
        draft.status = status;
        if (substate) {
          draft.substate = substate;
        } else {
          delete draft.substate;
        }
        draft.lastTimestamp = lastTimestamp ?? current.lastTimestamp;
        if (isToolUseState(current) && shouldFocus) {
          (draft as typeof current).ui.shouldFocusFollowUp = true;
        }
      }),
    );

    if (!wasSettled && isTranscriptSettlementPhase(status)) {
      appState.set(
        create(appState.get(), (draft) => {
          const streamLogs = draft.streamLogs.get(stream);
          if (!streamLogs) return;
          const updatedRowIndices = settleCompactionActivityLogs(streamLogs, {
            throughSeqNo: logHead,
            finishedAt: lastTimestamp,
          });
          if (updatedRowIndices.length === 0) return;
          draft.streamLogs.set(stream, {
            ...streamLogs,
            updatedRowIndices: [...updatedRowIndices],
            updatedRowBaseGeneration: streamLogs.generation,
            generation: streamLogs.generation + 1,
          });
        }),
      );
    }
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION]: (data) => {
    const { stream, description } = data;
    const prev = appState.get();
    // Registration metadata carries the same description, so an early patch
    // can be ignored until the authoritative stream entry arrives.
    if (!prev.streamById.has(stream)) return;
    appState.set(
      create(prev, (draft) => {
        const existing = draft.streamById.get(stream);
        // Replace via set() so the Map value identity changes and selectors
        // observing streamById propagate the update.
        if (existing) {
          draft.streamById.set(stream, { ...existing, description });
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS]: (data) => {
    setStreamStateForId(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.conversationProgress = data.progress;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STAGE]: (data) => {
    setStreamStateForId(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.stage = data.stage;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES]: (data) => {
    setStreamStateForId(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.subagents = data.subagents;
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
