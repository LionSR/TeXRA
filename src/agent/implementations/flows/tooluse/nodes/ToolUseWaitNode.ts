import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@shared/schemas';

import { findLastAssistantText, assertPreparedShared } from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, WaitExecResult } from './types';
import { FileInteractionState } from '@agent/core/AgentWorkspaceState';

interface WaitPrepResult {
  lastResponse: string | undefined;
  touchedFiles: string[];
}

export class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<WaitPrepResult> {
    const { modelHandler, onBeforeWaiting } = this.services;

    // Only extract last response when the callback is wired (subagent mode)
    if (!onBeforeWaiting) return { lastResponse: undefined, touchedFiles: [] };

    // Extract edited file paths from workspace state for delivery to orchestrator
    let touchedFiles: string[] = [];
    if (shared.stateSlices?.workspaceSnapshot?.interactions) {
      const interactions = FileInteractionState.fromSnapshot(
        shared.stateSlices.workspaceSnapshot.interactions,
      );
      touchedFiles = interactions.editedFilePaths;
    }

    return {
      lastResponse: findLastAssistantText(shared.messages, (m) =>
        modelHandler.extractAssistantText(m),
      ),
      touchedFiles,
    };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    const { checkInterruption, session, streamId, onBeforeWaiting } =
      this.services;

    if (checkInterruption()) {
      return { kind: 'stop' };
    }

    await onBeforeWaiting?.(prepRes.lastResponse, prepRes.touchedFiles);

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
