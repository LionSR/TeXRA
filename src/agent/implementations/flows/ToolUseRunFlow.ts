import { z } from 'zod';

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
  createStandardFinalizeNode,
  AgentLifecycle,
  type AgentRunHooks,
  type AgentRunShared,
  type NodeExecResult,
} from '@agent/implementations/flows/common';

// Schema export for serialization reference (runtime uses class instances)
export { ToolUseRunStateSchema } from '@agent/implementations/flows/common';

/**
 * Tool use run phase - single source of truth for tool-use agent flow phases.
 */
export const TOOL_USE_RUN_PHASE = {
  IDLE: 'idle',
  INIT: 'init',
  PREPARE: 'prepare',
  CYCLE: 'cycle',
  FINALIZE: 'finalize',
} as const;

export const ToolUseRunPhaseSchema = z.enum([
  TOOL_USE_RUN_PHASE.IDLE,
  TOOL_USE_RUN_PHASE.INIT,
  TOOL_USE_RUN_PHASE.PREPARE,
  TOOL_USE_RUN_PHASE.CYCLE,
  TOOL_USE_RUN_PHASE.FINALIZE,
]);

export type ToolUseRunPhase = z.infer<typeof ToolUseRunPhaseSchema>;

export type ToolUseRunLifecycle = AgentLifecycle<ToolUseRunPhase>;

/**
 * Schema for ToolUseRunHooks - runtime object with methods.
 * Uses z.custom for type safety without runtime validation.
 */
export interface ToolUseRunHooks<C = unknown> extends AgentRunHooks {
  prepareState(): Promise<{
    messages: ProviderMessage[];
    store: AgentSharedStore;
    shouldSkipCycle: boolean;
  }>;
  buildCycleOptions(store: AgentSharedStore): ToolUseCycleOptions<C>;
  runCycle(
    options: ToolUseCycleOptions<C>,
    messages: ProviderMessage[],
    store: AgentSharedStore,
  ): Promise<void>;
  checkInterruption(): boolean;
  hasQueuedFollowUp(): boolean;
  enterWaitingState(): Promise<void>;
  clearPersistedSnapshot(): Promise<void>;
  waitForFollowUp(): Promise<string | null>;
  markRunning(): Promise<void>;
  applyFollowUp(
    followUp: string,
    messages: ProviderMessage[],
  ): Promise<ProviderMessage[]>;
  persistCheckpoint(
    messages: ProviderMessage[],
    store: AgentSharedStore,
  ): Promise<void>;
  logFinalizeWarning?(message: string, error: unknown): void;
}

/**
 * Runtime state for tool-use agent runs.
 *
 * Schema alignment: This interface corresponds to {@link ToolUseRunStateSchema}
 * for serialization. The runtime uses class instances (AgentRunState, AgentSharedStore)
 * while the schema uses snapshot representations for JSON compatibility.
 */
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
  ToolUseRunHooks<C>
>;

// ============================================================================
// Prep Result Schemas - Single source of truth for node prep results
// ============================================================================

/**
 * Schema for ToolUsePrepareResult - the result of prepare execution.
 * Uses z.custom for runtime objects that can't be validated.
 */
const createToolUsePrepareResultSchema = <C>() =>
  z.object({
    messages: z.custom<ProviderMessage[]>(),
    store: z.custom<AgentSharedStore>(),
    shouldSkipCycle: z.boolean(),
    cycleOptions: z.custom<ToolUseCycleOptions<C>>(),
  });

type ToolUsePrepareResult<C> = z.infer<
  ReturnType<typeof createToolUsePrepareResultSchema<C>>
>;

type ToolUsePrepareExecResult<C> = NodeExecResult<ToolUsePrepareResult<C>>;

type ToolUseCycleExecResult = NodeExecResult<void>;

/**
 * Schema for ToolUsePrepareNode prep result.
 */
const createToolUsePrepareNodePrepResultSchema = <C>() =>
  z.object({
    hooks: z.custom<ToolUseRunHooks<C>>(),
  });

type ToolUsePrepareNodePrepResult<C> = z.infer<
  ReturnType<typeof createToolUsePrepareNodePrepResultSchema<C>>
>;

/**
 * Schema for ToolUseCycleNode prep result.
 */
const createToolUseCycleNodePrepResultSchema = <C>() =>
  z.object({
    hooks: z.custom<ToolUseRunHooks<C>>(),
    state: z.custom<ToolUseRunState<C>>(),
    cycleOptions: z.custom<ToolUseCycleOptions<C>>(),
  });

type ToolUseCycleNodePrepResult<C> = z.infer<
  ReturnType<typeof createToolUseCycleNodePrepResultSchema<C>>
>;

// ============================================================================
// Node Implementations
// ============================================================================

class ToolUsePrepareNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(
    shared: ToolUseRunShared<C>,
  ): Promise<ToolUsePrepareNodePrepResult<C>> {
    // Pure extraction - no side effects
    return { hooks: shared.hooks };
  }

  async exec(
    prepRes: ToolUsePrepareNodePrepResult<C>,
  ): Promise<ToolUsePrepareExecResult<C>> {
    try {
      const prepared = await prepRes.hooks.prepareState();
      const cycleOptions = prepRes.hooks.buildCycleOptions(prepared.store);
      return {
        result: {
          ...prepared,
          cycleOptions,
        } satisfies ToolUsePrepareResult<C>,
      };
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUsePrepareNodePrepResult<C>,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    // Lifecycle transition at start of post
    shared.lifecycle.begin('prepare');

    if (execRes.error || !execRes.result) {
      const error =
        execRes.error ??
        new Error('Failed to prepare tool-use run: no result from prepare');
      shared.lifecycle.fail(error);
      return FlowTransition.FINALIZE;
    }

    const { messages, store, shouldSkipCycle, cycleOptions } = execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    shared.state.store = store;

    shared.lifecycle.begin('cycle');

    return FlowTransition.EXECUTE;
  }
}

class ToolUseCycleNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(
    shared: ToolUseRunShared<C>,
  ): Promise<ToolUseCycleNodePrepResult<C>> {
    // Pure extraction - no side effects
    // Note: lifecycle.begin('cycle') is already called in ToolUsePrepareNode.post()
    return {
      hooks: shared.hooks,
      state: shared.state,
      cycleOptions: shared.state.cycleOptions!,
    };
  }

  async exec(
    prepRes: ToolUseCycleNodePrepResult<C>,
  ): Promise<ToolUseCycleExecResult> {
    const { hooks, state, cycleOptions } = prepRes;

    try {
      while (true) {
        if (!state.shouldSkipCycle) {
          if (!state.store) {
            throw new Error('Tool-use store is not initialized.');
          }
          await hooks.runCycle(cycleOptions, state.conversation, state.store);
          // Only persist successful cycles to avoid checkpointing failed state.
          await hooks.persistCheckpoint(state.conversation, state.store);
        } else {
          state.shouldSkipCycle = false;
        }

        if (hooks.checkInterruption()) {
          return { result: undefined };
        }

        if (hooks.hasQueuedFollowUp()) {
          await hooks.clearPersistedSnapshot();
        } else {
          await hooks.enterWaitingState();
        }

        const followUp = await hooks.waitForFollowUp();
        if (!followUp || hooks.checkInterruption()) {
          return { result: undefined };
        }

        await hooks.markRunning();
        await hooks.clearPersistedSnapshot();
        const updatedMessages = await hooks.applyFollowUp(
          followUp,
          state.conversation,
        );
        state.conversation = [...updatedMessages];
      }
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseCycleNodePrepResult<C>,
    execRes: ToolUseCycleExecResult,
  ): Promise<string | undefined> {
    if (execRes.error) {
      shared.lifecycle.fail(execRes.error);
    } else {
      shared.lifecycle.setStatus('running');
    }

    return FlowTransition.FINALIZE;
  }
}

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const finalizeNode = createStandardFinalizeNode<ToolUseRunShared<C>>({
    finalizePhase: 'finalize',
    beforeEnd: async ({ hooks }) => {
      await hooks.clearPersistedSnapshot();
    },
    onSecondaryError: ({ hooks }, error) =>
      hooks.logFinalizeWarning?.(
        'Additional finalize error encountered.',
        error,
      ),
  });

  return createAgentRunFlow<ToolUseRunShared<C>>({
    init: {
      phase: 'init',
      onSuccess: (shared) => {
        shared.lifecycle.begin('prepare');
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
