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
} from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';

import {
  createEmptyStreamLogs,
  isToolUseState,
  type StreamEntry,
} from '../store';
import { mergeBackendOwnedState } from './streamStateMerge';
import { appState, setStreamStateForId } from '../progressState';

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

/**
 * Insert/replace one stream's entry and re-sort the whole map by newest
 * creation time. Every OTHER stream's entry is reused as-is (same object
 * reference) — only the patched stream's entry and the map's key order
 * change.
 */
function upsertSortedStreamEntry(
  streams: Map<StreamTabId, StreamEntry>,
  entry: StreamEntry,
): Map<StreamTabId, StreamEntry> {
  const name = entry.info.name;
  const infosWithoutPatch = [...streams.values()]
    .map((existing) => existing.info)
    .filter((info) => info.name !== name);
  const ordered = [...infosWithoutPatch, entry.info].toSorted(
    compareByNewestCreationTime,
  );

  return new Map(
    ordered.map((info) =>
      info.name === name
        ? [info.name, entry]
        : [info.name, streams.get(info.name)!],
    ),
  );
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
    const existingEntry = prev.streams.get(name);
    const existingInfo = existingEntry?.info;
    const description =
      data.streamInfo.description ?? pending ?? existingInfo?.description;
    const streamInfo =
      description !== data.streamInfo.description
        ? { ...data.streamInfo, description }
        : data.streamInfo;
    const mergedState = mergeBackendOwnedState(
      existingEntry?.state,
      data.streamState,
    );

    appState.set(
      create(prev, (draft) => {
        if (
          !existingInfo ||
          existingInfo.creationTimestamp !== streamInfo.creationTimestamp
        ) {
          draft.streams = upsertSortedStreamEntry(prev.streams, {
            info: streamInfo,
            state: mergedState,
            logs: existingEntry?.logs ?? createEmptyStreamLogs(),
            followupOptions: existingEntry?.followupOptions ?? {},
          });
        } else {
          const target = draft.streams.get(name);
          if (target) {
            target.info = streamInfo;
            target.state = mergedState;
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
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION]: (data) => {
    const { stream, description } = data;
    // Subagent description can race its own UPDATE_STREAMS registration; if
    // the stream doesn't have an entry yet, buffer out-of-band so
    // streamLifecycleSlice can drain it on arrival.
    const entry = appState.get().streams.get(stream);
    if (!entry) {
      pendingDescriptions.set(stream, description);
      return;
    }
    appState.set(
      create(appState.get(), (draft) => {
        const target = draft.streams.get(stream);
        // Replace `.info` wholesale so its identity changes and selectors
        // observing streamById propagate the update (mirrors the pattern in
        // stateUtils.updateParentStreamId).
        if (target) {
          target.info = { ...entry.info, description };
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

  [PROGRESS_VIEW_COMMANDS.UPDATE_ROUND_STAGE]: (data) => {
    setStreamStateForId(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.roundStage = data.roundStage;
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
