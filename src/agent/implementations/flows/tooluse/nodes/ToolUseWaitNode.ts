import { maybeBuildGoalContinuation } from '@agent/goal';
import { Node } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { appendFollowUpAsUserMessage } from '@agent/toolUse/followUpMessages';
import { STREAM_STATUS } from '@shared/schemas';
import { GoalStore, setGoalSessionAutoApprovals } from '@tools/goal';

import { findLastAssistantText, extractTouchedFiles } from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
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
  /** Run cost so far (USD, including rolled-up subagents) for the goal cap. */
  runCostUsd: number;
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { modelHandler, onBeforeWaiting } = this.services;
    const afterError = !!(shared.lastError || shared.userCancelledRetry);

    // Only extract when the callback is wired (subagent mode)
    const previouslyDeliveredToOrchestrator =
      shared.deliveredToOrchestrator === true;
    const runCostUsd =
      shared.stateSlices?.runStateSnapshot.usageAccumulator.totals.totalCost ??
      0;

    if (!onBeforeWaiting)
      return {
        lastResponse: undefined,
        touchedFiles: [],
        afterError,
        previouslyDeliveredToOrchestrator,
        runCostUsd,
      };

    return {
      touchedFiles: extractTouchedFiles(shared.stateSlices),
      lastResponse: findLastAssistantText(shared.messages, (m) =>
        modelHandler.extractAssistantText(m),
      ),
      afterError,
      previouslyDeliveredToOrchestrator,
      runCostUsd,
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const {
      checkInterruption,
      session,
      streamId,
      streamStatus,
      onBeforeWaiting,
      runtimeHost,
      isSubagent,
    } = this.services;

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

    // Record this turn's spend against the goal and enforce the cost cap
    // BEFORE the continuation check — a cap-pause must stop the loop on the
    // same turn it trips, not one continuation later. Failed/cancelled parent
    // cycles still consumed model spend, so account for them before parking
    // the autonomous leg below. No-op without a goal.
    const costNote = await GoalStore.noteRunCost(streamId, prepRes.runCostUsd);
    if (costNote?.pausedForCap) {
      await setGoalSessionAutoApprovals(streamId, false, runtimeHost);
      this.services.logger.info(
        `Goal paused: cost cap reached ($${costNote.goal.spentUsd.toFixed(2)} ` +
          `of $${costNote.goal.costCapUsd?.toFixed(2)} cap). Resume the goal to continue.`,
      );
    }

    // A failed/cancelled cycle ends the autonomous leg. Pause any active
    // goal so it surfaces as resumable — the in-cycle retry layer already
    // absorbed transient errors before we reach here — instead of leaving the
    // record `active` while the loop is actually stalled on a blocking wait.
    if (prepRes.afterError) {
      const goal = GoalStore.getForStream(streamId);
      if (goal?.status === 'active') {
        await GoalStore.setStatus(streamId, 'paused');
        await setGoalSessionAutoApprovals(streamId, false, runtimeHost);
      }
    }
    if (!prepRes.afterError) {
      const delivered = await onBeforeWaiting?.(
        prepRes.lastResponse,
        prepRes.touchedFiles,
        this.services.attachedMemoryMisses ?? [],
      );
      prepRes.deliveredToOrchestrator =
        onBeforeWaiting !== undefined && delivered !== false;
    }

    if (this.services.stopAfterCycle) {
      return { kind: 'stop' };
    }

    // The Goal continuation runs BEFORE `waitForFollowUp` blocks; once
    // inside the wait, a continuation check is unreachable. Skipped after a
    // failed/cancelled cycle so the user-recovery path still fires. The
    // post-build re-check of `hasQueuedFollowUp` lets user input that arrived
    // during the build win the race.
    if (!prepRes.afterError) {
      const followUp = await maybeBuildGoalContinuation({
        streamId,
        isSubagent: !!isSubagent,
        hasQueuedFollowUp: session.hasQueuedFollowUp(),
      });
      if (followUp && !session.hasQueuedFollowUp()) {
        return {
          kind: 'continue',
          followUps: [{ text: followUp, origin: 'synthetic' as const }],
          synthetic: true,
        };
      }
    }

    if (!session.hasQueuedFollowUp()) {
      streamStatus.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost,
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
    const { onFollowUpConsumed, streamId, logger, runtimeHost, streamStatus } =
      this.services;

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

    // Synthesized continuations don't come from the user queue, so they
    // must not emit updateQueuedFollowUps via the consume callback. They
    // also don't need to be replayed in the chat log. Keep any prior
    // delivery marker across synthetic continuations because the orchestrator
    // has not consumed and replaced the delivered result.
    if (!execRes.synthetic) {
      shared.deliveredToOrchestrator = undefined;
      onFollowUpConsumed?.();
      for (const followUp of execRes.followUps) {
        logUserMessage(logger, followUp.displayText ?? followUp.text);
      }
    }
    streamStatus.set(streamId, STREAM_STATUS.RUNNING, {
      runtimeHost,
    });

    for (const followUp of execRes.followUps) {
      shared.messages = await appendFollowUpAsUserMessage(
        shared.messages,
        followUp,
        this.services,
      );
    }

    return FlowTransition.CONTINUE;
  }
}
