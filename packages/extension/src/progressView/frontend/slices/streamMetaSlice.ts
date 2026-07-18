/**
 * Stream metadata handlers: UPDATE_STREAM_STATUS, UPDATE_STREAM_DESCRIPTION,
 * UPDATE_CONVERSATION_PROGRESS, UPDATE_STREAM_BADGES, UPDATE_PROCESS_OUTPUT.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  createStreamState,
  STREAM_PHASE,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import {
  EMPTY_STREAM_META,
  reduceStreamMeta,
} from '@shared/streams/streamMetaReducer';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';

import {
  EMPTY_PROCESS_OUTPUTS,
  getStreamState,
  isToolUseState,
  type ProcessOutputMap,
} from '../store';
import {
  mergeBackendOwnedState,
  metadataToStreamStatePartial,
} from './streamStateMerge';
import type { HandlerRegistry } from '../messageHandlerTypes';

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
 * Per-output cap policy for the webview: keep at most 100k UTF-16 code units
 * per stdout/stderr, trimming to 80k when the cap is crossed so output can keep
 * appending for a while before the next reset. The shared reducer applies it.
 */
const WEBVIEW_OUTPUT_CAP = { maxChars: 100_000, retainChars: 80_000 } as const;

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

// `HandlerRegistry` is now exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const streamMetaHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA]: (data, ctx) => {
    const name = data.streamInfo.name;
    const pending = takePendingDescription(name);

    ctx.setState((prev) => {
      const existingInfo = prev.streamById.get(name);
      const description =
        data.streamInfo.description ?? pending ?? existingInfo?.description;
      const streamInfo =
        description !== data.streamInfo.description
          ? { ...data.streamInfo, description }
          : data.streamInfo;
      const existingState = prev.streamStates.get(name);
      const mergedState = existingState
        ? mergeBackendOwnedState(existingState, data.streamState)
        : createStreamState(
            data.streamState.kind,
            metadataToStreamStatePartial(data.streamState),
          );

      return create(prev, (draft) => {
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

        draft.streamStates.set(name, mergedState);

        if (data.activeStream !== undefined) {
          draft.activeStreamId = data.activeStream || null;
        }
        if (data.agentFilter !== undefined) {
          draft.streamFilter = data.agentFilter;
        }
      });
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: (data, ctx) => {
    const { stream, status, lastTimestamp, substate } = data;
    const state = ctx.getState();
    const isActiveStream = stream === state.activeStreamId;
    const shouldFocus = isActiveStream && status === STREAM_PHASE.WAITING;

    // Single atomic update: stream state + tab metadata in one setState call,
    // avoiding two Map copies and two Lit re-render triggers.
    ctx.setState((prev) => {
      const streamInfo = prev.streamById.get(stream);
      if (!streamInfo) return prev;

      const current = getStreamState(prev, stream, streamInfo.agentCategory);
      const resolvedTimestamp = lastTimestamp ?? current.lastTimestamp;
      const updatedState = create(current, (draft) => {
        draft.status = status;
        if (substate) {
          draft.substate = substate;
        } else {
          delete draft.substate;
        }
        draft.lastTimestamp = resolvedTimestamp;
        if (isToolUseState(current) && shouldFocus) {
          (draft as typeof current).ui.shouldFocusFollowUp = true;
        }
      });

      return create(prev, (draft) => {
        draft.streamStates.set(stream, updatedState);
      });
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION]: (data, ctx) => {
    const { stream, description } = data;
    // Subagent description can race its own UPDATE_STREAMS registration; if
    // the stream isn't in streamById yet, buffer out-of-band so
    // streamLifecycleSlice can drain it on arrival. Side effect lives
    // outside the state updater so updater stays pure.
    if (!ctx.getState().streamById.has(stream)) {
      pendingDescriptions.set(stream, description);
      return;
    }
    ctx.setState((prev) =>
      create(prev, (draft) => {
        const existing = draft.streamById.get(stream);
        // Replace via set() so the Map value identity changes and selectors
        // observing streamById propagate the update (mirrors the pattern in
        // stateUtils.updateParentStreamId).
        if (existing) {
          draft.streamById.set(stream, { ...existing, description });
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.conversationProgress = data.progress;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_ROUND_STAGE]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.roundStage = data.roundStage;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.activeSubagents = data.activeSubagents;
        draft.finishedSubagentCount = data.finishedSubagentCount;
        draft.activeProcesses = data.activeProcesses;
        draft.finishedProcessCount = data.finishedProcessCount;
      }),
    );
    // Prune output buffers for processes that just left the active list. Output
    // lives in a separate store, so only `processOutput` is projected into the
    // shared reducer and spliced back; an unchanged map skips the re-render.
    ctx.setState((prev) => {
      const current = prev.processOutputs.get(data.stream);
      if (!current) return prev;
      const { processOutput } = reduceStreamMeta(
        { ...EMPTY_STREAM_META, processOutput: current },
        { kind: 'activeProcesses', processes: data.activeProcesses },
        { outputCap: WEBVIEW_OUTPUT_CAP },
      );
      if (processOutput === current) return prev;
      return create(prev, (draft) => {
        draft.processOutputs.set(
          data.stream,
          processOutput as ProcessOutputMap,
        );
      });
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT]: (data, ctx) => {
    const { stream, executionId, stdout, stderr } = data;
    ctx.setState((prev) => {
      const current = prev.processOutputs.get(stream) ?? EMPTY_PROCESS_OUTPUTS;
      const { processOutput } = reduceStreamMeta(
        { ...EMPTY_STREAM_META, processOutput: current },
        { kind: 'processOutput', executionId, stdout, stderr },
        { outputCap: WEBVIEW_OUTPUT_CAP },
      );
      return create(prev, (draft) => {
        draft.processOutputs.set(stream, processOutput as ProcessOutputMap);
      });
    });
  },
} satisfies Partial<HandlerRegistry>;
