/**
 * ToolUsePrepareNode - Initializes tool-use session state.
 *
 * Handles both fresh starts and resumption from saved state.
 */
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { buildInitialToolUsePrompts } from '@utils/prompt';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, PrepareResult } from './types';

/** Result type for prepare node execution - success or error from execFallback. */
type PrepareExecResult =
  | { kind: 'success'; result: PrepareResult }
  | { kind: 'error'; error: Error };

export class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async exec(
    _prepRes: void,
  ): Promise<{ kind: 'success'; result: PrepareResult }> {
    const { userVarChannels, logger, snapshot } = this.services;

    if (snapshot) {
      logger.debug('Resuming tool-use session from saved state.');
      return {
        kind: 'success',
        result: {
          messages: snapshot.messages,
          runState: AgentRunState.fromSnapshot(snapshot.run),
          workspaceState: AgentWorkspaceState.fromSnapshot(snapshot.workspace),
          userChannels: {
            input: Object.freeze({ ...snapshot.user.input }),
            transient: { ...snapshot.user.transient },
          },
          compactionState: snapshot.compactionState ?? null,
          shouldSkipCycle: true,
        },
      };
    }

    const runState = new AgentRunState();
    const workspaceState = AgentWorkspaceState.create();
    const memoryEnabled = this.services.resolvedTools.some(
      (t) => t.name === 'memory',
    );

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.services.prompt,
        userVarChannels.transient,
        logger,
        { memoryEnabled },
      );

    // Log the initial instruction as a user message (consistent with follow-ups
    // logged in ToolUseWaitNode). This ensures the message is in stored logs
    // with correct timestamp, avoiding duplicate rendering issues on refresh.
    if (userRequest) {
      logger.userMessage(userRequest);
    }

    const systemMessage = systemPrompt
      ? `${systemPrompt}\n${instructionSuffix}`
      : instructionSuffix;
    const messages = await this.services.modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemMessage,
    );

    return {
      kind: 'success',
      result: {
        messages,
        runState,
        workspaceState,
        userChannels: userVarChannels,
        compactionState: null,
        shouldSkipCycle: false,
      },
    };
  }

  async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<{ kind: 'error'; error: Error }> {
    return { kind: 'error', error };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: PrepareExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      throw execRes.error;
    }

    const {
      messages,
      runState,
      workspaceState,
      userChannels,
      shouldSkipCycle,
      compactionState,
    } = execRes.result;
    shared.conversation = [...messages];
    shared.shouldSkipCycle = shouldSkipCycle;
    shared.compactionState = compactionState ?? null;
    shared.stateSlices = {
      runStateSnapshot: runState.toSnapshot(),
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels,
    };

    return FlowTransition.DEFAULT;
  }
}
