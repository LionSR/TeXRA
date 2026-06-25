import { maybeBuildGoalContinuation } from '@agent/goal';
import { Node } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  appendFollowUpAsUserMessage,
  followUpDisplayText,
} from '@agent/toolUse/followUpMessages';
import type { FlowParams } from '@agent/core/flows/BaseFlowServices';
import { STREAM_STATUS } from '@shared/schemas';
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
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  FlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { modelHandler, onBeforeWaiting } = this.services;
    const afterError = !!(shared.lastError || shared.userCancelledRetry);

    // Only extract when the callback is wired (subagent mode)
    const previouslyDeliveredToOrchestrator =
      shared.deliveredToOrchestrator === true;

    if (!onBeforeWaiting)
      return {
        lastResponse: undefined,
        touchedFiles: [],
        afterError,
        previouslyDeliveredToOrchestrator,
      };

    return {
      touchedFiles: extractTouchedFiles(shared.stateSlices),
      lastResponse: findLastAssistantText(shared.messages, (m) =>
        modelHandler.extractAssistantText(m),
      ),
      afterError,
      previouslyDeliveredToOrchestrator,
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
        runtimeHost.emit('goalPaused', { streamId });
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

    streamStatus.set(streamId, STREAM_STATUS.RUNNING, {
      runtimeHost,
    });

    // Synthesized continuations don't come from the user queue, so they
    // must not emit updateQueuedFollowUps via the consume callback. They
    // also don't need to be replayed in the chat log. Keep any prior
    // delivery marker across synthetic continuations because the orchestrator
    // has not consumed and replaced the delivered result.
    if (!execRes.synthetic) {
      shared.deliveredToOrchestrator = undefined;
      onFollowUpConsumed?.();
      for (const followUp of execRes.followUps) {
        logUserMessage(logger, followUpDisplayText(followUp));
      }
    }

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
