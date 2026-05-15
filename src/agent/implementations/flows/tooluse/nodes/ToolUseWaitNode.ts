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

    // Odyssey continuation must run BEFORE `waitForFollowUp` blocks; once
    // inside the wait, a continuation check is unreachable. Skipped after a
    // failed/cancelled cycle so the user-recovery path still fires. The
    // post-await re-check of `hasQueuedFollowUp` lets user input that
    // arrived during the prompt build win the race. See PRD §5.3.
    if (!prepRes.afterError) {
      const odysseyFollowUp = await maybeBuildOdysseyContinuation({
        streamId,
        isSubagent: !!isSubagent,
        hasQueuedFollowUp: session.hasQueuedFollowUp(),
      });
      if (odysseyFollowUp && !session.hasQueuedFollowUp()) {
        await OdysseyStore.recordEvent(streamId, 'continuation_injected');
        return {
          kind: 'continue',
          followUp: odysseyFollowUp,
          synthetic: true,
        };
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

    // Synthesized continuations (e.g. Odyssey) don't come from the user
    // queue, so they must not emit updateQueuedFollowUps via the consume
    // callback. They also don't need to be replayed in the chat log.
    if (!execRes.synthetic) {
      onFollowUpConsumed?.();
      logger.userMessage(execRes.followUp);
    }
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
      runtimeHost,
    });
    shared.messages = await modelHandler.createUserFollowUpMessages(
      shared.messages,
      execRes.followUp,
    );

    return FlowTransition.CONTINUE;
  }
}
