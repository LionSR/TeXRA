/**
 * Stream lifecycle handlers: UPDATE_STREAMS, SET_ACTIVE_STREAM,
 * DELETE_STREAM, DELETE_ALL, UPDATE_PARENT_STREAM.
 *
 * Owns updateStreamInfo and mergeBackendOwnedState helpers.
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
  deleteStreamState,
  firstStreamId,
  type ProgressState,
  type StreamState,
} from '../store';
import {
  appState,
  permissions$,
  unsupportedProgressCommands$,
} from '../progressState';
import { clearResolvedProposalIds } from './permissionSlice';
import { pendingDescriptions, takePendingDescription } from './streamMetaSlice';
import {
  mergeBackendOwnedState,
  metadataToStreamStatePartial,
} from './streamStateMerge';
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

// ============================================================
// Helpers
// ============================================================

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendMetadata?: Record<string, StreamMetadata>,
): ProgressState {
  // Pre-compute merged states outside the draft (mergeBackendOwnedState uses
  // create() internally, which cannot operate on draft proxies). Fold the
  // pending-description drain into the same pass — no extra iteration.
  // Explicit description on StreamTabInfo wins over the pending buffer.
  const mergedStates = new Map<string, StreamState>();
  const newStreamById = new Map<string, StreamTabInfo>();
  for (const stream of streams) {
    const existing = state.streamStates.get(stream.name);
    const metadata = backendMetadata?.[stream.name];
    if (metadata) {
      mergedStates.set(
        stream.name,
        existing
          ? mergeBackendOwnedState(existing, metadata)
          : createStreamState(
              stream.agentCategory,
              metadataToStreamStatePartial(metadata),
            ),
      );
    } else if (!existing) {
      mergedStates.set(stream.name, createStreamState(stream.agentCategory));
    }
    // Always drain the pending buffer so stale entries don't linger once the
    // stream registers, even if the payload already carries a description.
    // Stream-payload description wins (it's the authoritative value).
    const pending = takePendingDescription(stream.name);
    const description = stream.description ?? pending;
    newStreamById.set(
      stream.name,
      description !== stream.description ? { ...stream, description } : stream,
    );
  }

  // Clean up removed streams' pending-description buffer outside the
  // mutative draft callback so the side effect doesn't run if the draft
  // later throws.
  for (const key of state.streamStates.keys()) {
    if (!newStreamById.has(key)) {
      pendingDescriptions.delete(key);
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

    draft.streamById = newStreamById;
  });
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
    let nextActiveStreamId: StreamTabId | null;
    if (data.activeStream === '') {
      nextActiveStreamId = null;
    } else if (data.activeStream && updated.streamById.has(data.activeStream)) {
      nextActiveStreamId = data.activeStream;
    } else {
      nextActiveStreamId = firstStreamId(updated.streamById);
    }

    appState.set(
      create(updated, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
        draft.streamFilter = data.agentFilter;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM]: (data) => {
    const prev = appState.get();
    let nextActiveStreamId: StreamTabId | null;
    if (data.activeStream === '') {
      nextActiveStreamId = null;
    } else if (data.activeStream && prev.streamById.has(data.activeStream)) {
      nextActiveStreamId = data.activeStream;
    } else {
      nextActiveStreamId = firstStreamId(prev.streamById);
    }
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

    // Remove permissions for the deleted stream to prevent orphaned entries
    permissions$.set(removePermissionsForStream(permissions$.get(), streamId));

    pendingDescriptions.delete(streamId);
    appState.set(
      create(appState.get(), (draft) => {
        deleteStreamState(draft, streamId);
        draft.streamById.delete(streamId);
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

    appState.set(
      create(appState.get(), (draft) => {
        draft.streamById = new Map();
        draft.streamStates = new Map();
        draft.streamLogs = new Map();
        draft.processOutputs = new Map();
        draft.followupOptionsByStream = new Map();
        draft.activeStreamId = null;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM]: (data) => {
    updateParentStreamId(data.stream, data.parentStreamId);
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
