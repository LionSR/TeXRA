/**
 * ToolUseWaitNode - Waits for user follow-up messages.
 *
 * Manages the waiting state and processes follow-up messages.
 */
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async exec(): Promise<WaitExecResult> {
    if (this.services.checkInterruption()) {
      return { kind: 'stop' };
    }

    if (!this.services.session.hasQueuedFollowUp()) {
      await this.services.session.enterWaitingState();
    }

    const followUp = await this.services.session.waitForFollowUp(
      this.services.checkInterruption,
    );
    if (!followUp || this.services.checkInterruption()) {
      return { kind: 'stop' };
    }

    return { kind: 'continue', followUp };
  }

  async execFallback(
    _prepRes: void,
    error: Error,
  ): Promise<WaitExecResult> {
    this.services.logger.error(`ToolUseWaitNode error: ${error.message}`);
    return { kind: 'stop' };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      return FlowTransition.DEFAULT;
    }

    this.services.onFollowUpConsumed?.();
    await this.services.session.markRunning();
    this.services.logger.userMessage(execRes.followUp);
    shared.conversation =
      await this.services.modelHandler.createUserFollowUpMessages(
        shared.conversation,
        execRes.followUp,
      );

    return FlowTransition.CONTINUE;
  }
}
