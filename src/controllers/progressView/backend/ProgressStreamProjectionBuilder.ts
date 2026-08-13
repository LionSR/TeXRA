import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';

// Local imports - progress view
import {
  getDefaultProgressStreamControls,
  type GetProgressStreamControls,
} from '@controllers/progressView/progressStreamControls';
// Local imports - session
import {
  buildStreamInfo,
  buildStreamInfos,
} from '@controllers/session/streamInfoUtils';
import type { SessionState } from '@controllers/session/SessionState';
import type { PresentedStreamId } from '@controllers/session/SessionRendererPort';
// Local imports - shared
import {
  AgentCategory,
  type StreamMetadata,
  type StreamTabId,
  type StreamTabInfo,
  type SyncStreamContentPayload,
} from '@shared/schemas';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';
// Local imports - utilities
import { mapToRecord } from '@utils/core';

export interface ProjectedStreamMetadata {
  readonly streamInfo: StreamTabInfo;
  readonly streamState: StreamMetadata;
}

export interface ProjectedStreamRoster {
  readonly streams: StreamTabInfo[];
  readonly streamStates: Record<StreamTabId, StreamMetadata>;
}

/**
 * Projection boundary from hydrated session authority to immutable
 * composite progress-view values. Simple event payloads stay on the narrow
 * snapshot and follow-up store interfaces consumed by the renderer.
 */
export class ProgressStreamProjectionBuilder {
  constructor(
    private readonly state: SessionState,
    private readonly getStreamControls: GetProgressStreamControls = getDefaultProgressStreamControls,
  ) {}

  streamMetadata(
    streamId: StreamTabId,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
    activeStream: PresentedStreamId = '',
  ): ProjectedStreamMetadata {
    const streamInfo = buildStreamInfo(this.state, streamId, activeStream);
    return {
      streamInfo,
      streamState: this.metadataFor(
        streamInfo,
        streamStates ?? this.state.streamStatus.getAllStreamStates(),
      ),
    };
  }

  streamRoster(
    activeStream: PresentedStreamId,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
  ): ProjectedStreamRoster {
    const streams = buildStreamInfos(this.state, activeStream);
    const states = streamStates ?? this.state.streamStatus.getAllStreamStates();
    const projected: Record<StreamTabId, StreamMetadata> = {};
    for (const streamInfo of streams) {
      projected[streamInfo.name] = this.metadataFor(streamInfo, states);
    }
    return { streams, streamStates: projected };
  }

  streamContent(
    stream: StreamTabId,
    includeActiveState: boolean,
  ): SyncStreamContentPayload | undefined {
    const existingState = this.state.getStreamState(stream);
    const category =
      this.state.getStreamMetadata(stream).agentCategory ??
      existingState?.category;
    if (category === undefined) return undefined;

    const executionState = includeActiveState
      ? this.state.getOrCreateStreamState(stream, category)
      : undefined;
    const activeState = executionState
      ? {
          conversationProgress: executionState.conversationProgress,
          stage: executionState.stage ?? null,
          badges: { subagents: executionState.subagents },
        }
      : undefined;
    const shared = {
      action: 'render' as const,
      stream,
      runUsage: mapToRecord(this.state.snapshots.getRunUsage(stream)),
      ...(activeState ? { activeState } : {}),
    };

    if (category === AgentCategory.Workflow) {
      return {
        ...shared,
        category,
        outputs: {
          files: this.state.snapshots.getOutputFiles(stream),
          missing: this.state.snapshots.getMissingOutputs(stream),
          compileFailures: this.state.snapshots.getCompileFailures(stream),
        },
      };
    }

    const { todos, plan } = this.state.snapshots.getWorkPlan(stream);
    const controls = this.getStreamControls(stream);
    return {
      ...shared,
      category,
      workPlan: {
        todos,
        plan,
        queuedFollowUps: this.state.followUps.getAll(stream),
      },
      controls: {
        bashBypass: controls.bashBypass,
        toolEditBypass: controls.toolEditBypass,
        superYoloBypass: controls.superYoloBypass,
        goal: controls.goalActive
          ? {
              active: true,
              status: controls.goalStatus,
              objective: controls.goalObjective,
            }
          : { active: false },
      },
    };
  }

  private metadataFor(
    streamInfo: StreamTabInfo,
    streamStates?: Map<StreamTabId, StreamPhaseState>,
  ): StreamMetadata {
    const current = this.state.getStreamState(streamInfo.name);
    const status = streamStates?.get(streamInfo.name);
    return buildStreamMetadata({
      category: streamInfo.agentCategory,
      status: status?.phase,
      substate: status?.substate,
      userFollowUpSupport: streamInfo.userFollowUpSupport,
      lastTimestamp: this.state.streamLogs.getTimestampRange(streamInfo.name)
        .last,
      conversationProgress: current?.conversationProgress,
      stage: current?.stage,
      subagents: current?.subagents,
    });
  }
}
