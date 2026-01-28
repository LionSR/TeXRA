/**
 * ToolUseWaitNode - Waits for user follow-up messages.
 *
 * Manages the waiting state and processes follow-up messages.
 * Stream status transitions are handled directly here for explicit control flow.
 */
import { STREAM_STATUS } from '@shared/schemas';
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async exec(): Promise<WaitExecResult> {
    const { checkInterruption, session, streamId } = this.services;

    if (checkInterruption()) {
      return { kind: 'stop' };
    }

    // Only enter waiting state if no follow-ups are queued
    if (!session.hasQueuedFollowUp()) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
    }

    const followUp = await session.waitForFollowUp(checkInterruption);
    if (!followUp || checkInterruption()) {
      return { kind: 'stop' };
    }

    return { kind: 'continue', followUp };
  }

  async execFallback(_prepRes: void, error: Error): Promise<WaitExecResult> {
    const { logger } = this.services;
    logger.error(`ToolUseWaitNode error: ${error.message}`);
    return { kind: 'stop' };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    const { onFollowUpConsumed, streamId, logger, modelHandler } = this.services;

    if (execRes.kind === 'stop') {
      return FlowTransition.DEFAULT;
    }

    onFollowUpConsumed?.();
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);
    logger.userMessage(execRes.followUp);
    shared.conversation = await modelHandler.createUserFollowUpMessages(
      shared.conversation,
      execRes.followUp,
    );

    return FlowTransition.CONTINUE;
  }
}
