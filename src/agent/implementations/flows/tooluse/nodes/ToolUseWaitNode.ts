import { Node } from '@agent/node';
import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import {
  applyFollowUpBatch,
  userFollowUpInstruction,
} from '@agent/followUp/followUpMessages';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { USER_VAR_INSTRUCTION } from '@agent/prompt/userVars';
import { STREAM_PHASE } from '@shared/schemas';
import { GoalStore, setGoalSessionBashAutoApproval } from '@tools/goal';

import type { ToolUseServices } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

interface WaitPrepResult {
  /** Latest assistant text, read only by the root-mode `onIdle` notification. */
  lastResponse: string | undefined;
  /** True when entering after a failed/cancelled cycle. */
  afterError: boolean;
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseServices<C>
> {
  constructor(private drainedFollowUps?: readonly FollowUpQueueBatchItem[]) {
    super();
  }

  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { onIdle } = this.services;
    const modelHandler = this.services.modelCell.handler;

    // Only a wired `onIdle` reads the response text (a host projecting the
    // transcript before the flow blocks). A suspended subagent turn's facts
    // are read off the flow result by the child-run loop, not from here.
    let lastResponse: string | undefined;
    if (onIdle) {
      for (const message of shared.messages.toReversed()) {
        const text = modelHandler.extractAssistantText(message);
        if (text !== undefined) {
          lastResponse = text;
          break;
        }
      }
    }
    return {
      afterError: !!(shared.lastError || shared.userCancelledRetry),
      lastResponse,
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const { session, isSubagent, runScope } = this.services;
    const { streamId, session: ownerSession, signal } = runScope;
    const { stopAfterCycle } = useLaunchRunContext();
    const hasDrainedFollowUps = Boolean(this.drainedFollowUps?.length);

    if (signal.aborted) {
      return { kind: 'stop' };
    }

    // After a failed/cancelled cycle, skip notifying the orchestrator —
    // it must not see a failure as a successful completion.
    // In subagent mode, stop immediately: the orchestrator was never
    // notified, so waiting for a follow-up would hang forever.
    //
    // A batch the child-run loop already drained is the exception: it is
    // in hand, so there is nothing to wait for and no hang to avoid.
    // Stopping here would drop that user input on the floor — and skip the
    // `post` clear of `lastError`/`userCancelledRetry` that consuming it
    // performs, which is what makes the error recovered rather than terminal.
    if (prepRes.afterError && isSubagent && !hasDrainedFollowUps) {
      return { kind: 'stop' };
    }

    // A failed/cancelled cycle with no recovery input ends the autonomous
    // leg. Pause any active goal so it surfaces as resumable — the in-cycle
    // retry layer already absorbed transient errors before we reach here —
    // instead of leaving the record `active` while the loop is actually
    // stalled. A drained batch continues immediately and keeps the goal live.
    // The goalPaused event makes the pause user-visible: a silent stop
    // mid-objective reads as a hang.
    if (prepRes.afterError && !hasDrainedFollowUps) {
      await this.pauseActiveGoal(streamId);
    } else if (!isSubagent) {
      // Root-only notification: fires every cycle (not just a genuine
      // block) so a host can project each round's response as it happens —
      // e.g. the CLI syncing its terminal transcript live. Distinct from
      // subagent delivery below, which suspends the flow; this never does.
      this.services.onIdle?.(prepRes.lastResponse);
    }

    if (stopAfterCycle) {
      return { kind: 'stop' };
    }

    // A native child-run loop has already drained this batch from the stream
    // queue before it resumes the persisted flow. Consume that handoff once
    // and advance directly to the cycle node. Re-appending it through
    // ToolUseSessionLifecycle would return it to the same queue owner and make
    // every later WAITING suspension resume with the identical batch.
    const drainedFollowUps = this.drainedFollowUps;
    this.drainedFollowUps = undefined;
    if (drainedFollowUps?.length) {
      return {
        kind: 'continue',
        followUps: drainedFollowUps,
        synthetic: false,
      };
    }

    // With no externally consumed batch, subagent mode always exits WAITING
    // here. The child-run loop formats and delivers this cycle's turn facts
    // after suspension, then owns the next queue wait. This keeps every
    // ordinary suspension symmetric and leaves one delivery site.
    if (isSubagent) {
      ownerSession.status.transitionToWaiting(streamId, 'wait');
      return { kind: 'waiting' };
    }

    // The Goal continuation runs BEFORE `waitForFollowUp` blocks; once
    // inside the wait, a continuation check is unreachable. Skipped after a
    // failed/cancelled cycle so the user-recovery path still fires. The
    // post-build re-check of `hasQueuedFollowUp` lets user input that arrived
    // during the build win the race.
    if (!prepRes.afterError && !session.hasQueuedFollowUp()) {
      const followUp = await maybeBuildGoalContinuation(streamId);
      if (followUp && !session.hasQueuedFollowUp()) {
        return {
          kind: 'continue',
          followUps: [{ text: followUp, origin: 'synthetic' as const }],
          synthetic: true,
        };
      }
    }

    if (!session.hasQueuedFollowUp()) {
      ownerSession.status.transitionToWaiting(streamId, 'wait');
    }

    const batch = await session.waitForFollowUp(signal);
    if (!batch || signal.aborted) {
      return { kind: 'stop' };
    }

    return {
      kind: 'continue',
      followUps: batch.items,
      synthetic: batch.synthetic,
    };
  }

  async execFallback(
    _prepRes: WaitPrepResult,
    error: Error,
  ): Promise<WaitExecResult> {
    this.services.logger.error(`ToolUseWaitNode error: ${error.message}`);
    return { kind: 'stop' };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: WaitPrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    const { logger, runScope } = this.services;
    const { streamId, session } = runScope;

    if (execRes.kind === 'waiting') {
      return FlowTransition.WAITING;
    }

    if (execRes.kind === 'stop') {
      return FlowTransition.COMPLETE;
    }

    await session.transcripts.ensureLoaded(streamId);
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'resume');

    // Synthesized continuations don't come from the user queue, so they
    // must not emit updateQueuedFollowUps via the consume callback. They
    // also don't need to be replayed in the chat log.
    if (!execRes.synthetic) {
      const instruction = userFollowUpInstruction(execRes.followUps);
      if (instruction && shared.stateSlices) {
        shared.stateSlices.userChannels.transient[USER_VAR_INSTRUCTION] =
          instruction;
      }
    }

    try {
      await applyFollowUpBatch(
        shared,
        execRes.followUps,
        execRes.synthetic,
        this.services,
      );
    } catch (error) {
      if (prepRes.afterError) {
        await this.pauseActiveGoal(streamId);
      }
      throw error;
    }

    // A user follow-up reached the transcript and is ready for the next
    // cycle. Clear any prior error/cancellation state so runToolUseFlow does
    // not treat a recovered error as terminal. If applying the follow-up
    // failed above, preserve that state for the resumable failure path.
    shared.lastError = undefined;
    shared.userCancelledRetry = undefined;

    return FlowTransition.CONTINUE;
  }

  private async pauseActiveGoal(streamId: string): Promise<void> {
    const goal = GoalStore.getForStream(streamId);
    if (goal?.status !== 'active') {
      return;
    }

    await GoalStore.setStatus(streamId, 'paused');
    await setGoalSessionBashAutoApproval(streamId, false);
    emitRunFact(this.services.logger, 'goalPaused', { streamId });
  }
}
