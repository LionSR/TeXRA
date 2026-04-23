import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { buildInitialToolUsePrompts } from '@utils/prompt';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, PrepareResult } from './types';

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
          runState: snapshot.run,
          workspaceState: AgentWorkspaceState.fromSnapshot(snapshot.workspace),
          userChannels: {
            input: Object.freeze({ ...snapshot.user.input }),
            transient: { ...snapshot.user.transient },
          },
          shouldSkipCycle: true,
        },
      };
    }

    const runState = createRunState();
    const workspaceState = AgentWorkspaceState.create();
    const memoryEnabled = this.services.resolvedTools.some(
      (t) => t.name === 'memory',
    );
    const hasDelegationTools = this.services.resolvedTools.some((t) =>
      DELEGATION_TOOLS.has(t.name),
    );

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.services.prompt,
        userVarChannels.transient,
        logger,
        {
          memoryEnabled,
          hasDelegationTools,
          isSubagent: this.services.isSubagent,
          nestedDelegationBlocked: this.services.delegationTrimmed === true,
        },
      );

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
    } = execRes.result;
    shared.messages = [...messages];
    shared.shouldSkipCycle = shouldSkipCycle;
    shared.stateSlices = {
      runStateSnapshot: runState,
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels,
    };

    // Notify orchestrator that initialization is done and model call is about to start.
    // Without this, long initial prompts produce no progress updates, leaving
    // the orchestrator unaware that the subagent is working.
    this.services.onProgress?.({ kind: 'started' });

    return FlowTransition.DEFAULT;
  }
}
