/**
 * ToolUsePrepareNode - Initializes tool-use session state.
 *
 * Handles both fresh starts and resumption from saved state.
 */
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { type NodeExecResult } from '@agent/implementations/flows/common';
import { buildInitialToolUsePrompts } from '@utils/prompt';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, PrepareResult } from './types';

export class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async exec(
    _prepRes: void,
  ): Promise<{ kind: 'success'; result: PrepareResult }> {
    const { modelHandler, prompt, userVarChannels, logger, snapshot } =
      this.services;

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
        prompt,
        userVarChannels.transient,
        logger,
        { memoryEnabled },
      );

    const systemMessage = systemPrompt
      ? `${systemPrompt}\n${instructionSuffix}`
      : instructionSuffix;
    const messages = await modelHandler.initializeMessages(
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
        shouldSkipCycle: false,
      },
    };
  }

  async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<{ kind: 'error'; error: unknown }> {
    return { kind: 'error', error };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: NodeExecResult<PrepareResult>,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      if (execRes.error instanceof Error) {
        throw execRes.error;
      }
      throw new Error(String(execRes.error));
    }

    const {
      messages,
      runState,
      workspaceState,
      userChannels,
      shouldSkipCycle,
    } = execRes.result;
    shared.conversation = [...messages];
    shared.shouldSkipCycle = shouldSkipCycle;
    shared.stateSlices = {
      runStateSnapshot: runState.toSnapshot(),
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels,
    };

    return FlowTransition.DEFAULT;
  }
}
