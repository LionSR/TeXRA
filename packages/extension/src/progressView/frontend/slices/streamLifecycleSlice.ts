/**
 * Stream lifecycle handlers: stream registration, metadata, status, selection,
 * content release, and deletion.
 *
 * Owns the updateStreamInfo helper.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  isToolUseState,
  STREAM_PHASE,
  type ProgressViewOutboundHandlerRegistry,
  type StreamMetadata,
  type StreamState,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { isTranscriptSettlementPhase } from '@shared/streams/streamStatus';

import {
  deleteStreamState,
  detachChildStreamTabs,
  ensureStreamState,
  releaseStreamContent,
  type ProgressState,
} from '../store';
import {
  appState,
  permissions$,
  setStreamStateForId,
  unsupportedProgressCommands$,
} from '../progressState';
import { settleCompactionActivityLogs } from './logSlice';
import { clearResolvedProposalIds } from './permissionSlice';
import { mergeBackendOwnedState } from './streamStateMerge';
import {
  clearCopyContentStore,
  clearProposalInputStore,
} from '../formatters/contentStore';
import {
  clearFollowUpInputTransientStateStore,
  deleteFollowUpInputTransientState,
} from '../followUpInputState';
import { removePermissionsForStream } from '../stateUtils';
import { logListStateKey, webviewStorage } from '../webviewStorage';

// ============================================================
// Helpers
// ============================================================

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendMetadata?: Record<string, StreamMetadata>,
): ProgressState {
  // Pre-compute merged states outside the draft (mergeBackendOwnedState uses
  // create() internally, which cannot operate on draft proxies).
  const mergedStates = new Map<string, StreamState>();
  const newStreamById = new Map<string, StreamTabInfo>();
  // Streams with no backend metadata and no prior state yet: routed through
  // `ensureStreamState` below so their default streamStates entry and its
  // streamLogs companion are created together, instead of synthesizing a
  // bare streamStates default here.
  const streamsNeedingDefaultState: StreamTabInfo[] = [];
  for (const stream of streams) {
    const existing = state.streamStates.get(stream.name);
    const metadata = backendMetadata?.[stream.name];
    const merged = metadata
      ? mergeBackendOwnedState(existing, metadata)
      : undefined;
    if (merged) {
      mergedStates.set(stream.name, merged);
    } else if (!existing) {
      streamsNeedingDefaultState.push(stream);
    }
    newStreamById.set(stream.name, stream);
  }

  for (const key of state.streamStates.keys()) {
    if (!newStreamById.has(key)) {
      deleteFollowUpInputTransientState(key);
    }
  }

  return create(state, (draft) => {
    for (const key of draft.streamStates.keys()) {
      if (!newStreamById.has(key)) {
        deleteStreamState(draft, key);
      }
    }

    for (const [name, merged] of mergedStates) {
      draft.streamStates.set(name, merged);
    }

    for (const stream of streamsNeedingDefaultState) {
      // Pending streams (no resolved category) get their state once a later
      // UPDATE_STREAMS carries one.
      if (stream.agentCategory) {
        ensureStreamState(draft, stream.name, stream.agentCategory);
      }
    }

    draft.streamById = newStreamById;
  });
}

// Backend is sole source of truth for activeStream selection (see
// LitSessionRenderer.sendStreamMetadata); pass its value through unchanged and
// warn rather than silently re-deriving one if it's locally unknown.
function assertKnownActiveStreamId(
  activeStream: StreamTabId | '',
  streamById: Map<StreamTabId, StreamTabInfo>,
): StreamTabId | null {
  if (activeStream === '') return null;
  if (!streamById.has(activeStream)) {
    console.warn(
      '[streamLifecycleSlice] activeStream not present in streamById',
      activeStream,
    );
  }
  return activeStream;
}

// ============================================================
// Handlers
// ============================================================

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
export const streamLifecycleHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA]: (data) => {
    const { streamInfo: rawInfo, streamState, activeStream } = data;
    const previous = appState.get();
    const existingInfo = previous.streamById.get(rawInfo.name);
    const description = rawInfo.description ?? existingInfo?.description;
    const streamInfo =
      description !== rawInfo.description
        ? { ...rawInfo, description }
        : rawInfo;
    const streams = [
      ...[...previous.streamById.values()].filter(
        (stream) => stream.name !== streamInfo.name,
      ),
      streamInfo,
    ].toSorted(compareByNewestCreationTime);
    const updated = updateStreamInfo(previous, streams, {
      [streamInfo.name]: streamState,
    });

    appState.set(
      create(updated, (draft) => {
        // Metadata registration is followed by bridge replay. LOG_DELTA
        // settles only after applying that batch, so hydration cannot close
        // a start before its already-recorded outcome arrives.
        if (activeStream !== undefined) {
          draft.activeStreamId = activeStream || null;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]: (data) => {
    if (data.unsupportedCommands) {
      unsupportedProgressCommands$.set(new Set(data.unsupportedCommands));
    }
    const updated = updateStreamInfo(
      appState.get(),
      data.streams,
      data.streamStates,
    );
    // Honor explicit empty-string as "no selection" — backend sends this
    // when the current filter excludes every stream.
    const nextActiveStreamId = assertKnownActiveStreamId(
      data.activeStream,
      updated.streamById,
    );

    appState.set(
      create(updated, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
        // A full roster is authoritative recovery after attachment or a
        // transport interruption. Any unacknowledged visual intent is stale;
        // a later activation message can still apply the backend's result.
        draft.pendingStreamSelection = null;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM]: (data) => {
    const prev = appState.get();
    const nextActiveStreamId = assertKnownActiveStreamId(
      data.activeStream,
      prev.streamById,
    );
    if (
      nextActiveStreamId === prev.activeStreamId &&
      !prev.pendingStreamSelection
    )
      return;
    appState.set(
      create(prev, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
        draft.pendingStreamSelection = null;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION]: (data) => {
    const prev = appState.get();
    if (prev.pendingStreamSelection?.requestId !== data.requestId) return;
    appState.set(
      create(prev, (draft) => {
        draft.activeStreamId = data.activeStream || null;
        draft.pendingStreamSelection = null;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT]: (data) => {
    appState.set(
      create(appState.get(), (draft) => {
        releaseStreamContent(draft, data.stream);
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

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS]: (data) => {
    setStreamStateForId(data.stream, (previous) =>
      create(previous, (draft) => {
        draft.conversationProgress = data.progress;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data) => {
    const streamId = data.stream;

    // Always clear module-level caches for deleted stream
    clearResolvedProposalIds();
    clearCopyContentStore();
    clearProposalInputStore();
    deleteFollowUpInputTransientState(streamId);
    webviewStorage.delete(logListStateKey(streamId));

    // Remove permissions for the deleted stream to prevent orphaned entries
    permissions$.set(removePermissionsForStream(permissions$.get(), streamId));

    appState.set(
      create(appState.get(), (draft) => {
        deleteStreamState(draft, streamId);
        draft.streamById.delete(streamId);
        detachChildStreamTabs(draft, streamId);
        if (draft.activeStreamId === streamId) {
          draft.activeStreamId = null;
        }
        if (draft.pendingStreamSelection?.streamId === streamId) {
          draft.pendingStreamSelection = null;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => {
    clearResolvedProposalIds();
    clearCopyContentStore();
    clearProposalInputStore();
    clearFollowUpInputTransientStateStore();
    // Clear all permissions — no streams means no valid permissions
    permissions$.set([]);

    // Every remaining stream's persisted toggle state loses its only future
    // consumer here (the stream itself is about to disappear from
    // streamById below) — read the ids before the reset wipes them.
    for (const streamId of appState.get().streamById.keys()) {
      webviewStorage.delete(logListStateKey(streamId));
    }

    appState.set(
      create(appState.get(), (draft) => {
        draft.streamById = new Map();
        draft.streamStates = new Map();
        draft.streamLogs = new Map();
        draft.activeStreamId = null;
        draft.pendingStreamSelection = null;
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
