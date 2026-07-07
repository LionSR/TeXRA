import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { ToolUseBeforeWaitingCallback } from '@agent/implementations/flows/tooluse/ToolUseServices';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { AgentRunHandle } from '@agent/runtime/executionRegistry';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type SubagentProgressUpdate,
  type StreamTabId,
} from '@shared/schemas';
import { resumeToolUseFromSnapshot } from './executeAgent';
import { emitRuntimeEvent } from './emitRuntimeEvent';
import { defaultSession, type SessionHandle } from './SessionHandle';
import type { ToolEditApprovalPort } from '@platform/interfaces';

import type { AgentRuntimeHost } from './AgentRuntimeHost';

export interface ResumeQueuedToolUseOptions {
  /** Session owning this run's coordination state. Defaults to the process session. */
  readonly session?: SessionHandle;
  /** Tools hidden because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Per-run override for the host's tool-edit approval UI — see `ExecuteAgentOptions.toolEditApprovalHandler`. */
  readonly toolEditApprovalHandler?: ToolEditApprovalPort;
  /** Parent stream used when a native subagent resumes under its orchestrator. */
  readonly parentStreamId?: StreamTabId;
  /** Allow native subagent resume to halt at WAITING instead of terminalizing. */
  readonly allowWaitingResult?: boolean;
  readonly onBeforeWaiting?: ToolUseBeforeWaitingCallback;
  readonly onFollowUpConsumed?: () => void;
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  readonly onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  readonly onRunError?: (
    error: unknown,
    result: AgentFlowResult,
  ) => void | Promise<void>;
  readonly onRun?: (handle: AgentRunHandle) => void | Promise<void>;
  /**
   * Follow-ups to replay ahead of any items already queued for the stream
   * (e.g. an explicit follow-up typed alongside a manual resume). Seeded before
   * the drain so the failure path re-enqueues them even if the drain throws
   * before the full list is assigned.
   */
  readonly extraFollowUps?: readonly FollowUpQueueInput[];
  /**
   * Host-specific failure surface (log + toast). Invoked after the stream has
   * been returned to WAITING, so a blocking host dialog cannot strand the
   * stream in RESUMING while it awaits dismissal.
   */
  readonly onError: (error: unknown) => void | Promise<void>;
}

/**
 * Drive the shared tool-use resume "queue dance" that both the VS Code
 * extension and the desktop bridge wrap around `resumeToolUseFromSnapshot`:
 *
 *   acquire the follow-up queue → flip the stream to RESUMING → drain the
 *   queued follow-ups and notify the UI → resume, re-appending the drained
 *   items into the rebuilt session → on failure, re-enqueue the follow-ups
 *   (force) and re-notify → always return the stream to WAITING if the resume
 *   never reached the run lifecycle.
 *
 * Hosts stay thin adapters: they supply only what differs (`session`,
 * `runtimeUnavailableTools`, an optional seed follow-up, and the `onError`
 * toast). Returns `true` when the resume completed and `false` when it failed.
 */
export async function resumeQueuedToolUseSnapshot(
  streamId: StreamTabId,
  snapshot: ToolUseSessionSnapshot,
  runtimeHost: AgentRuntimeHost,
  options: ResumeQueuedToolUseOptions,
): Promise<boolean> {
  const session = options.session ?? defaultSession();
  const streamStatus = session.status;
  const followUpsQueue = session.followUps;

  followUpsQueue.acquire(streamId);
  streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
    events: session.events,
    substate: STREAM_SUBSTATE.RESUMING,
  });

  const seed = options.extraFollowUps ?? [];
  let followUps: readonly FollowUpQueueInput[] = seed;
  let resumeError: { error: unknown } | undefined;
  try {
    followUps = [...seed, ...followUpsQueue.drainItems(streamId)];
    emitRuntimeEvent('updateQueuedFollowUps', { streamId }, session);

    await resumeToolUseFromSnapshot(snapshot, runtimeHost, {
      session: options.session,
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      toolEditApprovalHandler: options.toolEditApprovalHandler,
      parentStreamId: options.parentStreamId,
      allowWaitingResult: options.allowWaitingResult,
      onBeforeWaiting: options.onBeforeWaiting,
      onFollowUpConsumed: options.onFollowUpConsumed,
      onProgress: options.onProgress,
      onCompleted: options.onCompleted,
      onError: options.onRunError,
      onRun: options.onRun,
      setupSession: (session) => {
        for (const item of followUps) {
          session.appendFollowUp(item);
        }
      },
    });
  } catch (error) {
    resumeError = { error };
    // Re-enqueue the drained follow-ups (explicit seed first) so a later
    // resume replays them instead of dropping them.
    for (const item of followUps) {
      followUpsQueue.enqueue(streamId, item, { force: true });
    }
    if (followUps.length > 0) {
      emitRuntimeEvent('updateQueuedFollowUps', { streamId }, session);
    }
  } finally {
    // Only the early-failure path leaves the stream RESUMING (a started run
    // owns its own status); settle it back to WAITING before surfacing the
    // error so a blocking host dialog cannot hold the stream in RESUMING.
    if (streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING) {
      streamStatus.transition(streamId, STREAM_PHASE.WAITING, 'wait', {
        events: session.events,
      });
    }
  }

  if (!resumeError) {
    return true;
  }
  try {
    await options.onError(resumeError.error);
  } catch {
    // A broken host error surface should not turn a handled resume failure into
    // an unhandled rejection.
  }
  return false;
}
