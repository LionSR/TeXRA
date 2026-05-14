import { Node } from '@agent/node';
import { maybeBuildOdysseyContinuation } from '@agent/odyssey';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@shared/schemas';
import { OdysseyStore } from '@tools/odyssey/odysseyStore';

import { findLastAssistantText, extractTouchedFiles } from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

interface WaitPrepResult {
  lastResponse: string | undefined;
  touchedFiles: string[];
  /** True when entering after a failed/cancelled cycle. */
  afterError: boolean;
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
    if (!onBeforeWaiting)
      return { lastResponse: undefined, touchedFiles: [], afterError };

    return {
      touchedFiles: extractTouchedFiles(shared.stateSlices),
      lastResponse: findLastAssistantText(shared.messages, (m) =>
        modelHandler.extractAssistantText(m),
      ),
      afterError,
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const {
      checkInterruption,
      session,
      streamId,
      onBeforeWaiting,
      runtimeHost,
      isSubagent,
    } = this.services;

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
    if (!prepRes.afterError) {
      await onBeforeWaiting?.(prepRes.lastResponse, prepRes.touchedFiles);
    }

    // Odyssey continuation runs BEFORE the blocking wait. session.waitForFollowUp
    // blocks indefinitely on an empty queue, so a post-wait check would be
    // unreachable in the happy path (idle user, active odyssey). See PRD §5.3.
    //
    // Three invariants this branch preserves:
    //   - Skipped after a failed/cancelled cycle (`prepRes.afterError`) so the
    //     existing user-recovery path still fires; otherwise post() would clear
    //     shared.lastError and the loop would burn turns on the broken state.
    //   - Helper rebuilds the prompt asynchronously; re-check
    //     `session.hasQueuedFollowUp()` immediately before returning so a user
    //     message that arrived during the async work still wins.
    //   - The `continuation_injected` audit event is recorded only on the
    //     committed branch (after the post-await re-check passes), keeping
    //     the history honest if the user-input race fires.
    if (!prepRes.afterError) {
      const odysseyFollowUp = await maybeBuildOdysseyContinuation({
        streamId,
        isSubagent: !!isSubagent,
        hasQueuedFollowUp: session.hasQueuedFollowUp(),
      });
      if (odysseyFollowUp && !session.hasQueuedFollowUp()) {
        await OdysseyStore.recordEvent(streamId, 'continuation_injected');
        return { kind: 'continue', followUp: odysseyFollowUp };
      }
    }

    if (!session.hasQueuedFollowUp()) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost,
      });
    }

    const items = await session.waitForFollowUp(checkInterruption);
    if (!items || checkInterruption()) {
      return { kind: 'stop' };
    }

    return { kind: 'continue', followUp: items.join('\n\n') };
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
    _prepRes: WaitPrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    const { onFollowUpConsumed, streamId, logger, modelHandler, runtimeHost } =
      this.services;

    if (execRes.kind === 'stop') {
      return FlowTransition.COMPLETE;
    }

    // User sent a follow-up — clear any prior error/cancellation state
    // so the next cycle starts fresh and runToolUseFlow won't treat
    // a previously-recovered error as a terminal failure.
    shared.lastError = undefined;
    shared.userCancelledRetry = undefined;

    onFollowUpConsumed?.();
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
      runtimeHost,
    });
    logger.userMessage(execRes.followUp);
    shared.messages = await modelHandler.createUserFollowUpMessages(
      shared.messages,
      execRes.followUp,
    );

    return FlowTransition.CONTINUE;
  }
}
