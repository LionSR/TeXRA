/**
 * Stream metadata handlers: UPDATE_STREAM_STATUS, UPDATE_STREAM_DESCRIPTION,
 * UPDATE_CONVERSATION_PROGRESS, UPDATE_STREAM_BADGES.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  STREAM_PHASE,
  type ProgressViewOutboundHandlerRegistry,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { isTranscriptSettlementPhase } from '@shared/streams/streamStatus';

import { isToolUseState, type StreamLogs } from '../store';
import { interruptCompactionActivityLogs } from './logSlice';
import { mergeBackendOwnedState } from './streamStateMerge';
import { appState, setStreamStateForId } from '../progressState';

function interruptSettledCompaction(
  streamLogs: StreamLogs,
  finishedAt?: number,
): StreamLogs | undefined {
  const updatedMessageIndices = interruptCompactionActivityLogs(
    streamLogs,
    finishedAt,
  );
  if (updatedMessageIndices.length === 0) return undefined;
  return {
    ...streamLogs,
    updatedMessageIndices: [...updatedMessageIndices],
    updatedMessageBaseGeneration: streamLogs.generation,
    generation: streamLogs.generation + 1,
  };
}

/**
 * Buffer for subagent descriptions that race their own UPDATE_STREAMS
 * registration. Lives as module state because it's purely transient plumbing
 * between two slices, not state the UI needs to observe.
 */
export const pendingDescriptions = new Map<StreamTabId, string>();

export function takePendingDescription(
  streamId: StreamTabId,
): string | undefined {
  const desc = pendingDescriptions.get(streamId);
  if (desc !== undefined) pendingDescriptions.delete(streamId);
  return desc;
}

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

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const streamMetaHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA]: (data) => {
    const name = data.streamInfo.name;
    const pending = takePendingDescription(name);

    const prev = appState.get();
    const existingInfo = prev.streamById.get(name);
    const description =
      data.streamInfo.description ?? pending ?? existingInfo?.description;
    const streamInfo =
      description !== data.streamInfo.description
        ? { ...data.streamInfo, description }
        : data.streamInfo;
    const mergedState = mergeBackendOwnedState(
      prev.streamStates.get(name),
      data.streamState,
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

        if (mergedState) {
          draft.streamStates.set(name, mergedState);
          if (isTranscriptSettlementPhase(mergedState.status)) {
            const streamLogs = draft.streamLogs.get(name);
            if (streamLogs) {
              const updated = interruptSettledCompaction(
                streamLogs,
                mergedState.lastTimestamp,
              );
              if (updated) draft.streamLogs.set(name, updated);
            }
          }
        }

        if (data.activeStream !== undefined) {
          draft.activeStreamId = data.activeStream || null;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: (data) => {
    const { stream, status, lastTimestamp, substate } = data;
    const shouldFocus =
      stream === appState.get().activeStreamId &&
      status === STREAM_PHASE.WAITING;

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

    if (isTranscriptSettlementPhase(status)) {
      appState.set(
        create(appState.get(), (draft) => {
          const streamLogs = draft.streamLogs.get(stream);
          if (!streamLogs) return;
          const updated = interruptSettledCompaction(streamLogs, lastTimestamp);
          if (updated) draft.streamLogs.set(stream, updated);
        }),
      );
    }
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION]: (data) => {
    const { stream, description } = data;
    // Subagent description can race its own UPDATE_STREAMS registration; if
    // the stream isn't in streamById yet, buffer out-of-band so
    // streamLifecycleSlice can drain it on arrival.
    if (!appState.get().streamById.has(stream)) {
      pendingDescriptions.set(stream, description);
      return;
    }
    appState.set(
      create(appState.get(), (draft) => {
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
