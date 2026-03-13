/**
 * Stream lifecycle handlers: UPDATE_STREAMS, SET_ACTIVE_STREAM,
 * DELETE_STREAM, DELETE_ALL, UPDATE_PARENT_STREAM.
 *
 * Owns updateStreamInfo and mergeBackendOwnedState helpers.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  createStreamState,
  type StreamMetadata,
  type StreamTabInfo,
} from '@shared/schemas';

import { firstStreamId, type ProgressState, type StreamState } from '../store';
import { clearResolvedProposalIds } from './permissionSlice';
import { clearCopyContentStore } from '../formatters/copyContentStore';
import { clearProposalInputStore } from '../formatters/proposalInputStore';
import {
  removePermissionsForStream,
  updateParentStreamId,
} from '../stateUtils';
import type { HandlerRegistry } from '../messageDispatcher';

// ============================================================
// Helpers
// ============================================================

function mergeBackendOwnedState(
  existing: StreamState,
  metadata: StreamMetadata,
): StreamState {
  if (existing.kind !== metadata.kind) {
    // Kind changed — create fresh state with new-kind defaults, overlay metadata,
    // and preserve frontend-owned taskGroups.
    return createStreamState(metadata.kind, {
      ...metadata,
      taskGroups: existing.taskGroups,
    });
  }
  return create(existing, (draft) => {
    draft.status = metadata.status;
    draft.lastTimestamp = metadata.lastTimestamp;
    draft.conversationProgress = metadata.conversationProgress;
    draft.activeSubagents = metadata.activeSubagents;
    draft.finishedSubagentCount = metadata.finishedSubagentCount;
    draft.activeProcesses = metadata.activeProcesses;
    draft.finishedProcessCount = metadata.finishedProcessCount;
  });
}

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendMetadata?: Record<string, StreamMetadata>,
): ProgressState {
  // Pre-compute merged states outside the draft (mergeBackendOwnedState uses
  // create() internally, which cannot operate on draft proxies).
  const mergedStates = new Map<string, StreamState>();
  for (const stream of streams) {
    const existing = state.streamStates.get(stream.name);
    const metadata = backendMetadata?.[stream.name];
    if (metadata) {
      mergedStates.set(
        stream.name,
        existing
          ? mergeBackendOwnedState(existing, metadata)
          : createStreamState(stream.agentCategory, metadata),
      );
    } else if (!existing) {
      mergedStates.set(stream.name, createStreamState(stream.agentCategory));
    }
  }

  const newStreamById = new Map(streams.map((s) => [s.name, s]));

  return create(state, (draft) => {
    for (const key of draft.streamStates.keys()) {
      if (!newStreamById.has(key)) {
        draft.streamStates.delete(key);
        draft.streamLogs.delete(key);
        draft.processOutputs.delete(key);
        draft.streamDescriptions.delete(key);
      }
    }

    for (const [name, merged] of mergedStates) {
      draft.streamStates.set(name, merged);
    }

    // Sync streamDescriptions from StreamTabInfo (initial load / refresh).
    // Clear descriptions for streams that no longer have one, and set new ones.
    for (const stream of streams) {
      if (stream.description) {
        draft.streamDescriptions.set(stream.name, stream.description);
      } else {
        draft.streamDescriptions.delete(stream.name);
      }
    }

    draft.streamById = newStreamById;
  });
}

// ============================================================
// Handlers
// ============================================================

export const streamLifecycleHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]: (data, ctx) => {
    const previousState = ctx.getState();
    const activeStream = data.activeStream || null;
    const updated = updateStreamInfo(
      previousState,
      data.streams,
      data.streamStates,
    );
    const nextActiveStreamId =
      activeStream && updated.streamById.has(activeStream)
        ? activeStream
        : firstStreamId(updated.streamById);

    ctx.setState(() =>
      create(updated, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
        draft.streamFilter = data.agentFilter;
        for (const key of draft.followupOptionsByStream.keys()) {
          if (!updated.streamById.has(key)) {
            draft.followupOptionsByStream.delete(key);
          }
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM]: (data, ctx) => {
    ctx.setState((prev) => {
      const nextActiveStreamId =
        data.activeStream && prev.streamById.has(data.activeStream)
          ? data.activeStream
          : firstStreamId(prev.streamById);
      if (nextActiveStreamId === prev.activeStreamId) {
        return prev;
      }
      return create(prev, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
      });
    });
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data, ctx) => {
    const streamId = data.stream;

    // Always clear module-level caches for deleted stream
    clearResolvedProposalIds();
    clearCopyContentStore();
    clearProposalInputStore();

    // Remove permissions for the deleted stream to prevent orphaned entries
    const cleaned = removePermissionsForStream(ctx.getPermissions(), streamId);
    ctx.setPermissions(cleaned);

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.streamStates.delete(streamId);
        draft.streamLogs.delete(streamId);
        draft.processOutputs.delete(streamId);
        draft.streamDescriptions.delete(streamId);
        draft.streamById.delete(streamId);
        if (draft.activeStreamId === streamId) {
          draft.activeStreamId = null;
        }
        draft.followupOptionsByStream.delete(streamId);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: (_data, ctx) => {
    clearResolvedProposalIds();
    clearCopyContentStore();
    clearProposalInputStore();

    // Clear all permissions — no streams means no valid permissions
    ctx.setPermissions([]);

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.streamById = new Map();
        draft.streamStates = new Map();
        draft.streamLogs = new Map();
        draft.processOutputs = new Map();
        draft.streamDescriptions = new Map();
        draft.activeStreamId = null;
        draft.followupOptionsByStream = new Map();
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM]: (data, ctx) => {
    updateParentStreamId(ctx, data.stream, data.parentStreamId);
  },
};
