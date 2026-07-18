/**
 * Native tool-use child-run strategy over the shared `childRunLoop`.
 *
 * `launch` is the first turn: `executeAgent` with `allowWaitingResult`,
 * capturing the live run handle via `onRun`. `runTurn` is every following
 * turn: resolve the persisted flow-record cursor for this execution
 * (`retrieveSessionResumeData`) and drive it to the next WAITING/terminal
 * boundary via `resumeToolUseFromSnapshot`, handing it the batch already
 * consumed by `childRunLoop`. Delivery choreography
 * (format/persist/manifest/deliver), duplicate-delivery prevention (there is
 * exactly one delivery site — the loop), and WAITING-cleanup registration all
 * live in the loop; this strategy owns only what is specific to a native
 * tool-use subagent: launching, resuming, and formatting its result shape.
 */

import type { ResultMeta } from '@agent/storage';
import { getExecutionStore } from '@agent/storage';
import {
  isWaitingFlowResult,
  type AgentFlowResult,
  type AgentRuntimeFlowResult,
} from '@agent/runtime/AgentFlowResult';
import {
  executeAgent,
  resumeToolUseFromSnapshot,
} from '@agent/runtime/executeAgent';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

import {
  buildSubagentFailureResultMeta,
  formatSubagentError,
} from '@tools/subagentResults';
import { subagentDeliveryMessage } from './subagentDeliveryFormat';

export interface NativeToolUseStrategyParams {
  readonly configPayload: AgentConfigPayload;
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly orchestratorStreamId: StreamTabId;
  readonly parentSession: SessionHandle;
  readonly runtimeHost: AgentRuntimeHost;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  readonly approvalPromptsUnavailable?: boolean;
  readonly runtimeUnavailableTools?: readonly string[];
  /** Fires with the resolved child stream id — the caller inherits approvals onto it. */
  readonly onStreamResolved: (streamId: StreamTabId) => void;
}

/**
 * Fold a WAITING turn into the shape `formatSubagentDelivery` expects — for
 * the orchestrator, a suspended turn reads as a completed cycle.
 */
function toDeliveryResult(
  turn: AgentRuntimeFlowResult,
  executionId: ExecutionId,
): AgentFlowResult {
  if (!isWaitingFlowResult(turn)) return turn;
  return {
    category: 'toolUse',
    outcome: RUN_OUTCOME.COMPLETED,
    lastResponse: turn.lastResponse,
    touchedFiles: turn.touchedFiles,
    executionId,
    streamId: turn.streamId,
    memoryMisses: turn.memoryMisses,
    totalCostUsd: turn.totalCostUsd,
  };
}

export function createNativeToolUseStrategy(
  params: NativeToolUseStrategyParams,
): ChildRunStrategy<AgentRuntimeFlowResult> {
  let runHandle: AgentRunHandle | undefined;
  // Captured for the turn currently in flight; read once the call resolves.
  // `executeAgent`/`resumeToolUseFromSnapshot` never reject for a
  // subagent's own application-level failure (runFlowWithLifecycle returns a
  // terminal failed result instead) — the real underlying error is only
  // observable through this callback.
  let lastErr: unknown;
  // formatDelivery always runs before buildResultMeta for the same turn (see
  // childRunLoop's deliverTurn) — cache the one diff-computing pass here so
  // a workflow subagent's diffs are written once per turn, not twice.
  let cachedDelivery: { msg: string; resultMeta: ResultMeta } | undefined;

  const resolveDeliveryTarget = (): StreamTabId | undefined =>
    runHandle ? runHandle.deliveryTargetStreamId : params.orchestratorStreamId;

  const runNative = async (
    ports: ChildRunPorts,
    call: () => Promise<AgentRuntimeFlowResult>,
  ): Promise<AgentRuntimeFlowResult> => {
    lastErr = undefined;
    cachedDelivery = undefined;
    const result = await call();
    // Every turn's totalCostUsd is the run's cumulative cost to date, not a
    // per-turn delta — recordCost just tracks the latest value; the loop
    // commits it to the parent exactly once, when the child's run ends.
    ports.recordCost(result.totalCostUsd);
    return result;
  };

  const buildDelivery = async (
    turn: AgentRuntimeFlowResult,
  ): Promise<{ msg: string; resultMeta: ResultMeta }> => {
    if (!cachedDelivery) {
      const result = toDeliveryResult(turn, params.executionId);
      cachedDelivery = await subagentDeliveryMessage(
        params.executionId,
        params.agentName,
        result,
        {
          startedAt: params.startedAt,
          workingDirectory: params.workingDirectory,
        },
      );
    }
    return cachedDelivery;
  };

  return {
    stageLabel: 'Native tool-use subagent',

    launch: (ports) =>
      runNative(ports, () =>
        executeAgent(params.configPayload, params.executionId, {
          runtimeHost: params.runtimeHost,
          session: params.parentSession,
          isSubagent: true,
          enforceCategory: true,
          parentStreamId: params.orchestratorStreamId,
          approvalPromptsUnavailable: params.approvalPromptsUnavailable,
          runtimeUnavailableTools: params.runtimeUnavailableTools,
          allowWaitingResult: true,
          onStreamResolved: params.onStreamResolved,
          onProgress: (update) => ports.notify(update),
          onRunError: (err) => {
            lastErr = err;
          },
          onRun: (handle) => {
            runHandle = handle;
          },
        }),
      ),

    runTurn: (followUps, ports) =>
      runNative(ports, async () => {
        const streamId = runHandle?.childStreamId;
        if (!streamId) {
          throw new Error(
            `Native subagent ${params.executionId} has no live stream to resume.`,
          );
        }
        const config = await getExecutionStore(params.executionId).readConfig();
        if (!config) {
          throw new Error(
            `Native subagent ${params.executionId} has no persisted config to resume.`,
          );
        }
        const resume = await retrieveSessionResumeData(
          streamId,
          params.executionId,
          config,
        );
        if (!resume || resume.type !== 'toolUse') {
          throw new Error(
            `Native subagent ${params.executionId} has no resumable tool-use snapshot.`,
          );
        }

        // childRunLoop already consumed this batch from the stream queue. A
        // queued-resume wrapper would append it to ToolUseSessionLifecycle,
        // which is backed by that same queue; the next WAITING result would
        // therefore feed the identical batch back into this method forever.
        // Hand it directly to the persisted WAITING cursor instead. Any item
        // that races into the queue after this drain remains there for the
        // loop's next turn.
        params.parentSession.status.transition(
          streamId,
          STREAM_PHASE.RUNNING,
          STREAM_TRANSITION_CAUSE.RESUME,
          {
            events: params.parentSession.events,
            substate: STREAM_SUBSTATE.RESUMING,
          },
        );
        return await resumeToolUseFromSnapshot(
          resume.snapshot,
          params.runtimeHost,
          {
            session: params.parentSession,
            approvalPromptsUnavailable: params.approvalPromptsUnavailable,
            runtimeUnavailableTools: params.runtimeUnavailableTools,
            parentStreamId: params.orchestratorStreamId,
            // The loop's queue never admits synthetic goal continuations for
            // a subagent, but its batch type is shared with root flows. Keep
            // the existing defensive downgrade rather than silently dropping
            // a future synthetic item.
            drainedFollowUps: followUps.map((item) => ({
              text: item.text,
              displayText: item.displayText,
              mediaFiles: item.mediaFiles,
              origin: item.origin === 'synthetic' ? 'user' : item.origin,
            })),
            onProgress: (update) => ports.notify(update),
            onRunError: (err) => {
              lastErr = err;
            },
            onRun: (handle) => {
              runHandle = handle;
            },
          },
        );
      }),

    isTerminal: (turn) => !isWaitingFlowResult(turn),
    isTurnError: () => lastErr !== undefined,

    resolveDeliveryTarget,

    formatDelivery: async (turn) => (await buildDelivery(turn)).msg,

    formatError: (turn, err) => {
      const wallTimeMs = Date.now() - params.startedAt;
      const result = turn
        ? toDeliveryResult(turn, params.executionId)
        : undefined;
      return formatSubagentError(
        params.executionId,
        params.agentName,
        lastErr ?? err,
        {
          wallTimeMs,
          workingDirectory: params.workingDirectory,
          memoryMisses: result?.memoryMisses,
        },
      );
    },

    buildResultMeta: async (turn, isError) => {
      if (isError || turn === null) {
        // Overwrite any interim success manifest from an earlier turn so
        // /executions/{id}/result never claims success for a failed run.
        const result = turn
          ? toDeliveryResult(turn, params.executionId)
          : undefined;
        return buildSubagentFailureResultMeta(
          params.agentName,
          'toolUse',
          result,
          Date.now() - params.startedAt,
        );
      }
      return (await buildDelivery(turn)).resultMeta;
    },
  };
}
