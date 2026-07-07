import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { Node } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import {
  appendFollowUpAsUserMessage,
  followUpDisplayText,
} from '@agent/followUp/followUpMessages';
import type { FlowParams } from '@agent/core/flows/BaseFlowServices';
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
  /** True when an earlier cycle already delivered this subagent result. */
  previouslyDeliveredToOrchestrator: boolean;
  /** Set after the current cycle has been delivered to an orchestrator. */
  deliveredToOrchestrator?: boolean;
  /** Run cost accumulated so far — forwarded to `onBeforeWaiting` so a
   *  suspended-then-abandoned native subagent can still settle its cost. */
  totalCostUsd?: number;
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  FlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { modelHandler, onBeforeWaiting } = this.services;

    // Only extract response/touched-files when the callback is wired (subagent mode).
    const wired = onBeforeWaiting !== undefined;

    return {
      afterError: !!(shared.lastError || shared.userCancelledRetry),
      previouslyDeliveredToOrchestrator:
        shared.deliveredToOrchestrator === true,
      touchedFiles: wired ? extractTouchedFiles(shared.stateSlices) : [],
      lastResponse: wired
        ? findLastAssistantText(shared.messages, (m) =>
            modelHandler.extractAssistantText(m),
          )
        : undefined,
      totalCostUsd:
        shared.stateSlices?.runStateSnapshot.usageAccumulator.totals.totalCost,
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const {
      checkInterruption,
      session,
      streamStatus,
      onBeforeWaiting,
      isSubagent,
    } = this.services;
    const { streamId, runtimeHost } = useLaunchRunContext();

    if (checkInterruption()) {
      if (prepRes.previouslyDeliveredToOrchestrator) {
        prepRes.deliveredToOrchestrator = true;
      }
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
    } else {
      // Always call `onBeforeWaiting`, even when an earlier cycle already
      // delivered this subagent's result. `NativeSubagentStrategy.onBeforeWaiting`
      // re-registers this turn's `abandon()` cleanup on the current
      // `runHandle` on every genuinely-suspending call — initial launch and
      // every resume alike (see its doc comment) — and is otherwise a no-op
      // "already delivered" short-circuit. Skipping the call here (as a
      // `previouslyDeliveredToOrchestrator` fast path once did) would leave a
      // turn that resumes already-delivered and suspends again with no
      // cleanup registered on its handle, so a later stop/kill of that
      // suspension would bypass the strategy's own teardown.
      const delivered = await onBeforeWaiting?.(
        prepRes.lastResponse,
        prepRes.touchedFiles,
        this.services.attachedMemoryMisses ?? [],
        prepRes.totalCostUsd,
      );
      prepRes.deliveredToOrchestrator =
        prepRes.previouslyDeliveredToOrchestrator ||
        (onBeforeWaiting !== undefined && delivered !== false);
    }

    const shouldSuspendNativeSubagent =
      isSubagent === true &&
      onBeforeWaiting !== undefined &&
      prepRes.deliveredToOrchestrator === true &&
      !this.services.stopAfterCycle;
    if (shouldSuspendNativeSubagent && !session.hasQueuedFollowUp()) {
      streamStatus.transitionToWaiting(streamId, 'wait', {
        runtimeHost,
        trace: this.services.logger,
      });
      return { kind: 'waiting' };
    }

    if (this.services.stopAfterCycle) {
      return { kind: 'stop' };
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
        runtimeHost,
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
    const { onFollowUpConsumed, logger, streamStatus } = this.services;
    const { streamId, runtimeHost } = useLaunchRunContext();

    if (execRes.kind === 'waiting') {
      if (prepRes.deliveredToOrchestrator) {
        shared.deliveredToOrchestrator = true;
      }
      return FlowTransition.WAITING;
    }

    if (execRes.kind === 'stop') {
      if (prepRes.deliveredToOrchestrator) {
        shared.deliveredToOrchestrator = true;
      }
      return FlowTransition.COMPLETE;
    }

    // User sent a follow-up — clear any prior error/cancellation state
    // so the next cycle starts fresh and runToolUseFlow won't treat
    // a previously-recovered error as a terminal failure.
    shared.lastError = undefined;
    shared.userCancelledRetry = undefined;
    if (prepRes.deliveredToOrchestrator) {
      shared.deliveredToOrchestrator = true;
    }

    streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
      runtimeHost,
      trace: logger,
    });

    // Synthesized continuations don't come from the user queue, so they
    // must not emit updateQueuedFollowUps via the consume callback. They
    // also don't need to be replayed in the chat log. Keep any prior
    // delivery marker across synthetic continuations because the orchestrator
    // has not consumed and replaced the delivered result.
    if (!execRes.synthetic) {
      shared.deliveredToOrchestrator = undefined;
      onFollowUpConsumed?.();
    }

    for (const followUp of execRes.followUps) {
      const result = await appendFollowUpAsUserMessage(
        shared.messages,
        followUp,
        this.services,
      );
      shared.messages = result.messages;
      if (!execRes.synthetic) {
        logUserMessage(
          logger,
          followUpDisplayText(followUp),
          result.attachmentKinds,
        );
      }
    }

    return FlowTransition.CONTINUE;
  }
}
