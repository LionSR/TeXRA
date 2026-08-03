/**
 * Stream lifecycle handlers: UPDATE_STREAMS, SET_ACTIVE_STREAM,
 * DELETE_STREAM, DELETE_ALL, UPDATE_PARENT_STREAM.
 *
 * Owns the updateStreamInfo helper.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  createStreamState,
  type ProgressViewOutboundHandlerRegistry,
  type StreamMetadata,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';

import {
  createEmptyStreamLogs,
  firstStreamId,
  type ProgressState,
  type StreamEntry,
} from '../store';
import {
  appState,
  permissions$,
  unsupportedProgressCommands$,
} from '../progressState';
import { clearResolvedProposalIds } from './permissionSlice';
import { pendingDescriptions, takePendingDescription } from './streamMetaSlice';
import { mergeBackendOwnedState } from './streamStateMerge';
import {
  clearCopyContentStore,
  clearProposalInputStore,
} from '../formatters/contentStore';
import {
  clearFollowUpInputTransientStateStore,
  deleteFollowUpInputTransientState,
} from '../followUpInputState';
import {
  removePermissionsForStream,
  updateParentStreamId,
} from '../stateUtils';
import { logListStateKey, webviewStorage } from '../webviewStorage';

// ============================================================
// Helpers
// ============================================================

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendMetadata?: Record<string, StreamMetadata>,
): ProgressState {
  // Pre-compute the replacement `streams` map outside the draft
  // (mergeBackendOwnedState uses create() internally, which cannot operate
  // on draft proxies). Fold the pending-description drain into the same
  // pass — no extra iteration. Explicit description on StreamTabInfo wins
  // over the pending buffer. Built wholesale (not patched in place) so a
  // stream absent from `streams` is naturally dropped — the single-map
  // equivalent of the old delete-from-every-map pass.
  const newStreams = new Map<StreamTabId, StreamEntry>();
  for (const stream of streams) {
    const existing = state.streams.get(stream.name);
    const metadata = backendMetadata?.[stream.name];
    const streamState = metadata
      ? mergeBackendOwnedState(existing?.state, metadata)
      : (existing?.state ?? createStreamState(stream.agentCategory));

    // Always drain the pending buffer so stale entries don't linger once the
    // stream registers, even if the payload already carries a description.
    // Stream-payload description wins (it's the authoritative value).
    const pending = takePendingDescription(stream.name);
    const description = stream.description ?? pending;
    const info =
      description !== stream.description ? { ...stream, description } : stream;

    newStreams.set(stream.name, {
      info,
      state: streamState,
      logs: existing?.logs ?? createEmptyStreamLogs(),
      followupOptions: existing?.followupOptions ?? {},
    });
  }

  // Clean up removed streams' pending-description buffer outside the
  // mutative draft callback so the side effect doesn't run if the draft
  // later throws.
  for (const key of state.streams.keys()) {
    if (!newStreams.has(key)) {
      pendingDescriptions.delete(key);
      deleteFollowUpInputTransientState(key);
    }
  }

  return create(state, (draft) => {
    draft.streams = newStreams;
  });
}

/**
 * Resolve the next active stream id for an incoming `activeStream` value:
 * an explicit empty string means "no selection", a known stream id is kept
 * as-is, and anything else (unset or no-longer-present) falls back to the
 * first available stream.
 */
function resolveActiveStreamId(
  activeStream: StreamTabId | '',
  streams: Map<StreamTabId, StreamEntry>,
): StreamTabId | null {
  if (activeStream === '') return null;
  if (activeStream && streams.has(activeStream)) return activeStream;
  return firstStreamId(streams);
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
export const streamLifecycleHandlers = {
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
    // when the current filter excludes every stream. Since the backend now
    // emits all streams unfiltered, falling back to firstStreamId would
    // re-pick a filtered-out tab and render hidden-category content.
    const nextActiveStreamId = resolveActiveStreamId(
      data.activeStream,
      updated.streams,
    );

    appState.set(
      create(updated, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM]: (data) => {
    const prev = appState.get();
    const nextActiveStreamId = resolveActiveStreamId(
      data.activeStream,
      prev.streams,
    );
    if (nextActiveStreamId === prev.activeStreamId) return;
    appState.set(
      create(prev, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
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

    pendingDescriptions.delete(streamId);
    appState.set(
      create(appState.get(), (draft) => {
        draft.streams.delete(streamId);
        if (draft.activeStreamId === streamId) {
          draft.activeStreamId = null;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => {
    clearResolvedProposalIds();
    clearCopyContentStore();
    clearProposalInputStore();
    clearFollowUpInputTransientStateStore();
    pendingDescriptions.clear();

    // Clear all permissions — no streams means no valid permissions
    permissions$.set([]);

    // Every remaining stream's persisted toggle state loses its only future
    // consumer here (the stream itself is about to disappear from `streams`
    // below) — read the ids before the reset wipes them.
    for (const streamId of appState.get().streams.keys()) {
      webviewStorage.delete(logListStateKey(streamId));
    }

    appState.set(
      create(appState.get(), (draft) => {
        draft.streams = new Map();
        draft.activeStreamId = null;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM]: (data) => {
    updateParentStreamId(data.stream, data.parentStreamId);
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
