import { Node } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import {
  appendFollowUpAsUserMessage,
  followUpDisplayText,
  userFollowUpInstruction,
  type AppendFollowUpResult,
} from '@agent/followUp/followUpMessages';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { STREAM_PHASE } from '@shared/schemas';
import { GoalStore, setGoalSessionBashAutoApproval } from '@tools/goal';

import { findLastAssistantText, extractTouchedFiles } from './types';
import type { ToolUseServices } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

interface WaitPrepResult {
  lastResponse: string | undefined;
  touchedFiles: string[];
  /** True when entering after a failed/cancelled cycle. */
  afterError: boolean;
  /** Run cost accumulated so far — carried on the WAITING turn facts so the
   *  child-run loop can settle cost even for a suspended-then-abandoned turn. */
  totalCostUsd?: number;
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseServices<C>
> {
  constructor(private drainedFollowUps?: readonly FollowUpQueueBatchItem[]) {
    super();
  }

  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { modelHandler, isSubagent, onIdle } = this.services;

    // Subagent mode needs these turn facts for every delivery (the loop's
    // one delivery site). Root mode only needs `lastResponse`, and only when
    // `onIdle` is wired (a host projecting the transcript before it blocks).
    const wantsLastResponse = isSubagent === true || onIdle !== undefined;
    return {
      afterError: !!(shared.lastError || shared.userCancelledRetry),
      touchedFiles: isSubagent ? extractTouchedFiles(shared.stateSlices) : [],
      lastResponse: wantsLastResponse
        ? findLastAssistantText(shared.messages, (m) =>
            modelHandler.extractAssistantText(m),
          )
        : undefined,
      totalCostUsd:
        shared.stateSlices?.runStateSnapshot.usageAccumulator.totals.totalCost,
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const { checkInterruption, session, isSubagent } = this.services;
    const { runScope, stopAfterCycle } = useLaunchRunContext();
    const { streamId, runtimeHost, session: runSession } = runScope;
    const streamStatus = runSession.status;

    if (checkInterruption()) {
      return { kind: 'stop' };
    }

    // After a failed/cancelled cycle, skip notifying the orchestrator —
    // it must not see a failure as a successful completion.
    // In subagent mode, stop immediately: the orchestrator was never
    // notified, so waiting for a follow-up would hang forever.
    if (prepRes.afterError && isSubagent) {
      return { kind: 'stop' };
    }

    // A failed/cancelled cycle ends the autonomous leg. Pause any active
    // goal so it surfaces as resumable — the in-cycle retry layer already
    // absorbed transient errors before we reach here — instead of leaving the
    // record `active` while the loop is actually stalled on a blocking wait.
    // The goalPaused event makes the pause user-visible: a silent stop
    // mid-objective reads as a hang.
    if (prepRes.afterError) {
      const goal = GoalStore.getForStream(streamId);
      if (goal?.status === 'active') {
        await GoalStore.setStatus(streamId, 'paused');
        await setGoalSessionBashAutoApproval(streamId, false, runtimeHost);
        emitRunFact(this.services.logger, 'goalPaused', { streamId });
      }
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
    if (drainedFollowUps && drainedFollowUps.length > 0) {
      return {
        kind: 'continue',
        followUps: drainedFollowUps,
        synthetic: false,
      };
    }

    // With no externally consumed batch, subagent mode always exits WAITING
    // here, carrying this cycle's turn facts
    // (lastResponse/touchedFiles/totalCostUsd). The child-run loop formats and
    // delivers after suspension, then owns the next queue wait. This keeps
    // every ordinary suspension symmetric and leaves one delivery site.
    if (isSubagent === true) {
      streamStatus.transitionToWaiting(streamId, 'wait', {
        trace: this.services.logger,
      });
      return { kind: 'waiting' };
    }

    // The Goal continuation runs BEFORE `waitForFollowUp` blocks; once
    // inside the wait, a continuation check is unreachable. Skipped after a
    // failed/cancelled cycle so the user-recovery path still fires. The
    // post-build re-check of `hasQueuedFollowUp` lets user input that arrived
    // during the build win the race.
    if (!prepRes.afterError && !isSubagent && !session.hasQueuedFollowUp()) {
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
      streamStatus.transitionToWaiting(streamId, 'wait', {
        trace: this.services.logger,
      });
    }

    const batch = await session.waitForFollowUp(checkInterruption);
    if (!batch || checkInterruption()) {
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
    const { onFollowUpConsumed, logger } = this.services;
    const { runScope } = useLaunchRunContext();
    const { streamId, session: runSession } = runScope;

    if (execRes.kind === 'waiting') {
      return FlowTransition.WAITING;
    }

    if (execRes.kind === 'stop') {
      return FlowTransition.COMPLETE;
    }

    // A user follow-up is ready for the next cycle. Clear any prior
    // error/cancellation state so runToolUseFlow does not treat a recovered
    // error as terminal. Root flows arrive here from their session queue;
    // resumed subagents arrive here through the one-shot handoff above.
    shared.lastError = undefined;
    shared.userCancelledRetry = undefined;

    runSession.status.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
      trace: logger,
    });

    // Synthesized continuations don't come from the user queue, so they
    // must not emit updateQueuedFollowUps via the consume callback. They
    // also don't need to be replayed in the chat log.
    if (!execRes.synthetic) {
      const instruction = userFollowUpInstruction(execRes.followUps);
      if (instruction && shared.stateSlices) {
        shared.stateSlices.userChannels.transient.INSTRUCTION = instruction;
      }
    }

    for (const followUp of execRes.followUps) {
      // A non-synthetic follow-up's transcript row must be logged whether
      // appendFollowUpAsUserMessage succeeds or throws (e.g. a corrupt/
      // oversized media file) -- otherwise a failed resume leaves no record
      // of what the user asked for. `finally` preserves the throw so the
      // resume still fails as before; a throw before any attachment was
      // inserted just yields an empty attachments list, which is accurate
      // (nothing was actually inserted). Synthetic follow-ups are still
      // never logged, throw or not -- unchanged from before this fix.
      let result: AppendFollowUpResult | undefined;
      try {
        result = await appendFollowUpAsUserMessage(
          shared.messages,
          followUp,
          this.services,
        );
        shared.messages = result.messages;
      } finally {
        if (!execRes.synthetic) {
          logUserMessage(
            logger,
            followUpDisplayText(followUp),
            result?.attachmentKinds ?? [],
          );
        }
      }
    }

    // Acknowledge consumption only after every item actually landed in
    // `shared.messages`: an append failure (e.g. corrupt media) must leave
    // the batch unacknowledged so the resume wrapper restores it for replay
    // instead of treating the lost input as consumed.
    if (!execRes.synthetic) {
      onFollowUpConsumed?.();
    }

    return FlowTransition.CONTINUE;
  }
}
