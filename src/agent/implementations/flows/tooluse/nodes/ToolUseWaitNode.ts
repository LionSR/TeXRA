import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { processFollowUpItems } from '@agent/toolUse/FollowUpQueue';
import { STREAM_STATUS } from '@shared/schemas';

import { findLastAssistantText } from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

interface WaitPrepResult {
  lastResponse: string | undefined;
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { modelHandler, onBeforeWaiting } = this.services;

    // Only extract last response when the callback is wired (subagent mode)
    if (!onBeforeWaiting) return { lastResponse: undefined };

    return {
      lastResponse: findLastAssistantText(shared.messages, (m) =>
        modelHandler.extractAssistantText(m),
      ),
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const {
      checkInterruption,
      session,
      streamId,
      onBeforeWaiting,
      onResumeToolFollowUp,
    } = this.services;

    if (checkInterruption()) {
      return { kind: 'stop' };
    }

    await onBeforeWaiting?.(prepRes.lastResponse);

    // Loop: process resume_tool items automatically, return on text items
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!session.hasQueuedFollowUp()) {
        StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
      }

      const items = await session.waitForFollowUp(checkInterruption);
      if (!items || checkInterruption()) {
        return { kind: 'stop' };
      }

      const followUp = await processFollowUpItems(
        items,
        onResumeToolFollowUp,
      );
      if (followUp !== null) {
        return { kind: 'continue', followUp };
      }
      // All items were resume_tool — continue waiting for more
    }
  }

  async execFallback(
    _prepRes: WaitPrepResult,
    error: Error,
  ): Promise<WaitExecResult> {
    const { logger } = this.services;
    logger.error(`ToolUseWaitNode error: ${error.message}`);
    return { kind: 'stop' };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: WaitPrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    const { onFollowUpConsumed, streamId, logger, modelHandler } =
      this.services;

    if (execRes.kind === 'stop') {
      return FlowTransition.DEFAULT;
    }

    onFollowUpConsumed?.();
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);
    logger.userMessage(execRes.followUp);
    shared.messages = await modelHandler.createUserFollowUpMessages(
      shared.messages,
      execRes.followUp,
    );

    return FlowTransition.CONTINUE;
  }
}
