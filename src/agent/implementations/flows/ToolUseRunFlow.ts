// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState } from '@agent/core/AgentState';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import {
  createAgentRunFlow,
  createAgentFinalizeNode,
  beginLifecyclePhase,
  failLifecycle,
  setLifecycleStatus,
  runNodeExecution,
  type AgentLifecycleState,
  type AgentRunHooks,
  type AgentRunShared,
  type NodeExecResult,
} from '@agent/implementations/flows/common';

interface ToolUsePrepareResult<C> {
  messages: ProviderMessage[];
  store: AgentSharedStore;
  shouldSkipCycle: boolean;
  cycleOptions: ToolUseCycleOptions<C>;
}

type ToolUsePrepareExecResult<C> = NodeExecResult<ToolUsePrepareResult<C>>;

type ToolUseCycleExecResult = NodeExecResult<void>;

export type ToolUseRunPhase =
  | 'idle'
  | 'init'
  | 'prepare'
  | 'cycle'
  | 'finalize';

export type ToolUseRunLifecycle = AgentLifecycleState<ToolUseRunPhase>;

export interface ToolUseRunState<C = unknown> {
  conversation: ProviderMessage[];
  cycleOptions: ToolUseCycleOptions<C> | null;
  shouldSkipCycle: boolean;
  store: AgentSharedStore | null;
  runState: AgentRunState;
}

export type ToolUseRunShared<C = unknown> = AgentRunShared<
  BaseToolUseAgent<C>,
  ToolUseRunState<C>,
  ToolUseRunLifecycle,
  AgentRunHooks
>;

class ToolUsePrepareNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseRunShared<C>> {
    beginLifecyclePhase(shared.lifecycle, 'prepare');
    return shared;
  }

  async exec(
    shared: ToolUseRunShared<C>,
  ): Promise<ToolUsePrepareExecResult<C>> {
    return runNodeExecution(async () => {
      // Call agent methods directly - no hook indirection
      const prepared = await shared.agent.prepareInitialSessionState();
      const cycleOptions = shared.agent.buildToolUseCycleOptions(prepared.store);
      return {
        ...prepared,
        cycleOptions,
      } satisfies ToolUsePrepareResult<C>;
    });
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseRunShared<C>,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    if (execRes.error || !execRes.result) {
      const error =
        execRes.error ??
        new Error('Failed to prepare tool-use run: no result from prepare');
      failLifecycle(shared.lifecycle, error);
      return FlowTransition.FINALIZE;
    }

    const { messages, store, shouldSkipCycle, cycleOptions } = execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    shared.state.store = store;

    beginLifecyclePhase(shared.lifecycle, 'cycle');

    return FlowTransition.EXECUTE;
  }
}

class ToolUseCycleNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseRunShared<C>> {
    beginLifecyclePhase(shared.lifecycle, 'cycle');
    return shared;
  }

  async exec(shared: ToolUseRunShared<C>): Promise<ToolUseCycleExecResult> {
    const { agent, state } = shared;
    const cycleOptions = state.cycleOptions!;

    return runNodeExecution(async () => {
      while (true) {
        if (!state.shouldSkipCycle) {
          if (!state.store) {
            throw new Error('Tool-use store is not initialized.');
          }
          // Call agent method directly - no hook indirection
          await agent.runToolUseCycle(cycleOptions, state.conversation, state.store);
        } else {
          state.shouldSkipCycle = false;
        }

        // Call agent methods directly - no hook indirection
        if (agent.isInterruptionRequested()) {
          return;
        }

        if (agent.hasQueuedFollowUp()) {
          await agent.clearPersistedSnapshot();
        } else {
          await agent.enterWaitingState();
        }

        const followUp = await agent.waitForFollowUp();
        if (!followUp || agent.isInterruptionRequested()) {
          return;
        }

        await agent.markRunning();
        await agent.clearPersistedSnapshot();
        const updatedMessages = await agent.applyFollowUpMessage(
          followUp,
          state.conversation,
        );
        state.conversation = [...updatedMessages];
      }
    });
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseRunShared<C>,
    execRes: ToolUseCycleExecResult,
  ): Promise<string | undefined> {
    if (execRes.error) {
      failLifecycle(shared.lifecycle, execRes.error);
    } else {
      setLifecycleStatus(shared.lifecycle, 'running');
    }

    return FlowTransition.FINALIZE;
  }
}

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const finalizeNode = createAgentFinalizeNode<
    ToolUseRunShared<C>,
    'error' | 'stopped'
  >({
    finalizePhase: 'finalize',
    computeStatus: ({ lifecycle }) =>
      lifecycle.status === 'error' ? 'error' : 'stopped',
    runFinalize: async ({ agent, hooks }, status) => {
      // Call agent method directly - no hook indirection
      await agent.clearPersistedSnapshot();
      await hooks.end(status);
    },
    runCleanup: async ({ hooks }) => {
      await hooks.cleanup();
    },
    onSuccess: ({ lifecycle }) => setLifecycleStatus(lifecycle, 'completed'),
    onSecondaryError: ({ agent }, error) => {
      // Call agent method directly - no hook indirection
      agent.logFinalizeWarning('Additional finalize error encountered.', error);
    },
  });

  return createAgentRunFlow<ToolUseRunShared<C>>({
    init: {
      phase: 'init',
      onSuccess: (shared) => {
        beginLifecyclePhase(shared.lifecycle, 'prepare');
        return FlowTransition.EXECUTE;
      },
    },
    finalize: finalizeNode,
    links: ({ init }) => [
      { from: init, on: FlowTransition.EXECUTE, to: prepareNode },
      { from: prepareNode, on: FlowTransition.EXECUTE, to: cycleNode },
      { from: prepareNode, on: FlowTransition.FINALIZE },
      { from: cycleNode, on: FlowTransition.FINALIZE },
    ],
  });
}
