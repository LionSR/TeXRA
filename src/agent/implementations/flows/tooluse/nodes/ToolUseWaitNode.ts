/**
 * ToolUseWaitNode - Waits for user follow-up messages.
 *
 * Manages the waiting state and processes follow-up messages.
 * Stream status transitions are handled directly here for explicit control flow.
 *
 * For subagents: fires onBeforeWaiting callback before entering WAITING,
 * delivering the current result to the orchestrator while staying alive
 * for potential follow-ups.
 */
import { STREAM_STATUS } from '@shared/schemas';
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

/** Result from prep: last assistant response for subagent reporting. */
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

    for (let i = shared.messages.length - 1; i >= 0; i--) {
      const text = modelHandler.extractAssistantText(shared.messages[i]);
      if (text !== undefined) {
        return { lastResponse: text };
      }
    }
    return { lastResponse: undefined };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const { checkInterruption, session, streamId, onBeforeWaiting } =
      this.services;

    if (checkInterruption()) {
      return { kind: 'stop' };
    }

    // Deliver result to orchestrator before entering WAITING.
    // The subagent stays alive for follow-ups, but the orchestrator
    // gets the response immediately instead of waiting for flow exit.
    onBeforeWaiting?.(prepRes.lastResponse);

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
