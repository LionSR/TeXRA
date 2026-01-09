/**
 * ToolUseRunFlow - PocketFlow implementation for tool-use agents.
 *
 * Flow: prepare → cycle → wait (loop back via CONTINUE)
 * Services injected via flow.setServices(), accessed via this.services.
 */

import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  AgentRunState,
  type AgentRunStateSnapshot,
} from '@agent/core/AgentState';
import {
  AgentWorkspaceState,
  type AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import { interpretCycleCompletion } from '@agent/core/flows/CommonCycleTypes';

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import {
  type NodeExecResult,
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import { buildInitialToolUsePrompts } from '@utils/prompt';
import type { TodoItem } from '@eventBus/schemas';
import { bus } from '@eventBus/ProgressEventBus';

import { type ToolUseServices, type ToolUseFlowParams } from './tooluse';

// ============================================================================
// State Types
// ============================================================================

interface StateSlicesSnapshot {
  runStateSnapshot: AgentRunStateSnapshot;
  workspaceSnapshot: AgentWorkspaceSnapshot;
  userChannels: UserVariableChannels;
}

/** Runtime state stored as serializable snapshots for PersistedFlow. */
export interface ToolUseRunState {
  conversation: ProviderMessage[];
  shouldSkipCycle: boolean;
  stateSlices: StateSlicesSnapshot | null;
  userCancelledRetry?: boolean;
}

export interface ToolUseRunShared {
  state: ToolUseRunState;
}

// ============================================================================
// Result Types
// ============================================================================

interface PrepareResult {
  messages: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  shouldSkipCycle: boolean;
}

type CycleExecResult =
  | { kind: 'success'; messages: ProviderMessage[] }
  | { kind: 'skipped' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

type WaitExecResult =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop' };

interface CyclePrepResult {
  shouldSkip: boolean;
  conversation: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

// ============================================================================
// State Guards
// ============================================================================

type PreparedState = ToolUseRunState & { stateSlices: StateSlicesSnapshot };

function assertPreparedState(
  state: ToolUseRunState,
): asserts state is PreparedState {
  if (state.stateSlices === null) {
    throw new Error('PrepareNode must run before CycleNode');
  }
}

// ============================================================================
// Node Implementations
// ============================================================================

class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(_shared: ToolUseRunShared): Promise<void> {}

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
      throw execRes.error instanceof Error
        ? execRes.error
        : new Error(String(execRes.error));
    }

    const { messages, runState, workspaceState, userChannels, shouldSkipCycle } =
      execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.stateSlices = {
      runStateSnapshot: runState.toSnapshot(),
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels,
    };

    return FlowTransition.DEFAULT;
  }
}

class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ToolUseRunShared): Promise<CyclePrepResult> {
    assertPreparedState(shared.state);

    const { stateSlices } = shared.state;
    return {
      shouldSkip: shared.state.shouldSkipCycle,
      conversation: shared.state.conversation,
      runState: AgentRunState.fromSnapshot(stateSlices.runStateSnapshot),
      workspaceState: AgentWorkspaceState.fromSnapshot(
        stateSlices.workspaceSnapshot,
      ),
      userChannels: stateSlices.userChannels,
    };
  }

  async exec(prepRes: CyclePrepResult): Promise<CycleExecResult> {
    if (prepRes.shouldSkip) {
      const recoveredTodos = prepRes.workspaceState.todos.todos;
      if (recoveredTodos.length > 0) {
        bus.emit('updateTodos', {
          stream: this.services.streamId,
          executionId: this.services.executionId,
          todos: recoveredTodos,
        });
      }
      return { kind: 'skipped' };
    }

    const cycleShared: ToolUseCycleShared = {
      messages: prepRes.conversation,
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      cycleIndex: prepRes.runState.totalRounds,
      cycleResponseTimeMs: 0,
      cycleNormalizedUsage: undefined,
    };

    const services = this.services;
    const flow = createToolUseCycleFlow<C>();
    flow.setServices({
      ...services,
      setting: { ...services.setting, tools: services.resolvedTools },
      client: await services.modelHandler.getClient(),
      run: prepRes.runState,
      workspace: prepRes.workspaceState,
      onRoundFinalized: services.getUsageRecorder(),
      modelName: services.config.model,
      agentName: services.config.agent,
    });

    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', {
        stream: this.services.streamId,
        executionId: this.services.executionId,
        todos,
      });
    });

    try {
      await flow.run(cycleShared);

      const completion = interpretCycleCompletion(cycleShared);
      if (completion.failedWithError) {
        return {
          kind: 'failed',
          message: completion.errorMessage ?? 'Cycle failed',
        };
      }
      if (completion.userCancelled) {
        return { kind: 'cancelled' };
      }
      return { kind: 'success', messages: cycleShared.messages };
    } finally {
      prepRes.workspaceState.todos.clearOnUpdate();
    }
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'failed', message: error.message };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CyclePrepResult,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    if (prepRes.shouldSkip) {
      shared.state.shouldSkipCycle = false;
    }

    shared.state.stateSlices = {
      runStateSnapshot: prepRes.runState.toSnapshot(),
      workspaceSnapshot: prepRes.workspaceState.toSnapshot(),
      userChannels: prepRes.userChannels,
    };

    switch (execRes.kind) {
      case 'success':
        shared.state.conversation = execRes.messages;
        return FlowTransition.DEFAULT;

      case 'skipped':
        return FlowTransition.DEFAULT;

      case 'failed':
        throw new Error(execRes.message);

      case 'cancelled':
        shared.state.userCancelledRetry = true;
        return FlowTransition.FINALIZE;
    }
  }
}

class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(_shared: ToolUseRunShared): Promise<{ interrupted: boolean }> {
    return { interrupted: this.services.checkInterruption() };
  }

  async exec(prepRes: { interrupted: boolean }): Promise<WaitExecResult> {
    if (prepRes.interrupted) {
      return { kind: 'stop' };
    }

    const session = this.services.session;
    if (!session.hasQueuedFollowUp()) {
      await session.enterWaitingState();
    }

    const followUp = await session.waitForFollowUp(
      this.services.checkInterruption,
    );
    if (!followUp || this.services.checkInterruption()) {
      return { kind: 'stop' };
    }

    return { kind: 'continue', followUp };
  }

  async execFallback(
    _prepRes: { interrupted: boolean },
    error: Error,
  ): Promise<WaitExecResult> {
    this.services.logger.error(`ToolUseWaitNode error: ${error.message}`);
    return { kind: 'stop' };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: { interrupted: boolean },
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      return FlowTransition.DEFAULT;
    }

    this.services.onFollowUpConsumed?.();

    const session = this.services.session;
    await session.markRunning();
    this.services.logger.userMessage(execRes.followUp);
    shared.state.conversation =
      await this.services.modelHandler.createUserFollowUpMessages(
        shared.state.conversation,
        execRes.followUp,
      );

    return FlowTransition.CONTINUE;
  }
}

// ============================================================================
// Flow Factory
// ============================================================================

/** Creates a tool-use flow: prepare → cycle → wait (loop via CONTINUE). */
export function createToolUseRunFlow<C = unknown>(): Flow<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const waitNode = new ToolUseWaitNode<C>();

  prepareNode.next(cycleNode);
  cycleNode.next(waitNode);
  waitNode.on(FlowTransition.CONTINUE, cycleNode);

  return new Flow<ToolUseRunShared, ToolUseFlowParams, ToolUseServices<C>>(
    prepareNode,
  );
}
