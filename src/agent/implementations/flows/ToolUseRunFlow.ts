import { z } from 'zod';

// Local imports - core flow primitives
import { BaseNode, Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  AgentSharedStore,
  AgentSharedStoreSnapshotSchema,
} from '@agent/core/AgentSharedStore';
import {
  AgentRunState,
  AgentRunStateSnapshotSchema,
} from '@agent/core/AgentState';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import {
  type ProviderMessage,
  ProviderMessageSchema,
} from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentRunHooks } from '@agent/core/IAgent';
// Internal imports
import {
  StandardFinalizeNode,
  AgentLifecycle,
  type AgentRunShared,
  type FinalizeContext,
  type InitExecResult,
  type NodeExecResult,
} from '@agent/implementations/flows/common';

// ============================================================================
// Serialization Schema (formerly in common/runStateSchemas.ts)
// ============================================================================

/** Tool-use agent run state schema for serialization. */
export const ToolUseRunStateSchema = z.object({
  runState: AgentRunStateSnapshotSchema,
  conversation: z.array(ProviderMessageSchema),
  // Runtime-only field, not serializable (contains functions)
  cycleOptions: z.unknown().nullable(),
  shouldSkipCycle: z.boolean(),
  store: AgentSharedStoreSnapshotSchema.nullable(),
});

export type ToolUseRunStateSnapshot = z.infer<typeof ToolUseRunStateSchema>;

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
 * Hooks interface for tool-use agent runs.
 *
 * Note: Session lifecycle methods (waitForFollowUp, applyFollowUp, clearPersistedSnapshot,
 * checkInterruption, hasQueuedFollowUp, markRunning, enterWaitingState) are called
 * directly on the agent, not via hooks. This follows PocketFlow's pattern where
 * nodes interact with the domain object (agent) directly for stateful operations.
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
  ): Promise<{
    failedWithError: boolean;
    errorMessage?: string;
    userCancelled: boolean;
  }>;
  persistCheckpoint(
    messages: ProviderMessage[],
    store: AgentSharedStore,
  ): Promise<void>;
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
// Result Types - Clean discriminated unions following PocketFlow patterns
// ============================================================================

/**
 * Result of prepare execution.
 */
interface ToolUsePrepareResult<C> {
  messages: ProviderMessage[];
  store: AgentSharedStore;
  shouldSkipCycle: boolean;
  cycleOptions: ToolUseCycleOptions<C>;
}

type ToolUsePrepareExecResult<C> = NodeExecResult<ToolUsePrepareResult<C>>;

/**
 * Result of a single cycle execution.
 * Uses 'kind' discriminant for clarity (matches PocketFlow's InvocationResult).
 */
type CycleExecResult =
  | { kind: 'success' }
  | { kind: 'skipped' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

/**
 * Result of waiting for follow-up.
 */
type WaitExecResult =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop'; reason: 'interrupted' | 'no-followup' };

/**
 * Prep result for ToolUsePrepareNode.
 */
interface ToolUsePrepareNodePrepResult<C> {
  hooks: ToolUseRunHooks<C>;
}

/**
 * Prep result for ToolUseCycleNode.
 */
interface CycleNodePrepResult<C> {
  shouldSkip: boolean;
  cycleOptions: ToolUseCycleOptions<C>;
  conversation: ProviderMessage[];
  store: AgentSharedStore;
  hooks: ToolUseRunHooks<C>;
}

/**
 * Prep result for ToolUseWaitNode.
 */
interface WaitNodePrepResult {
  interrupted: boolean;
  followUp?: string;
}

// ============================================================================
// State Guards
// ============================================================================

/** Prepared state type with non-null cycleOptions and store. */
type PreparedState<C> = ToolUseRunState<C> & {
  cycleOptions: ToolUseCycleOptions<C>;
  store: AgentSharedStore;
};

/**
 * Type predicate to check if state has been prepared.
 * Use when you want to handle unprepared state gracefully.
 */
function isPreparedState<C>(
  state: ToolUseRunState<C>,
): state is PreparedState<C> {
  return state.cycleOptions !== null && state.store !== null;
}

/**
 * Asserts that state has been prepared (cycleOptions and store are non-null).
 * Called by CycleNode to ensure PrepareNode has run before entering cycle.
 *
 * This provides:
 * - Type narrowing (removes `| null` from types)
 * - Fail-fast with descriptive error if flow invariant is violated
 * - Documentation of the PrepareNode → CycleNode contract
 *
 * For cases where you want to handle unprepared state gracefully,
 * use {@link isPreparedState} instead.
 */
function assertPreparedState<C>(
  state: ToolUseRunState<C>,
): asserts state is PreparedState<C> {
  if (!isPreparedState(state)) {
    const missing = [];
    if (!state.cycleOptions) missing.push('cycleOptions');
    if (!state.store) missing.push('store');
    throw new Error(
      `CycleNode invariant violated: ${missing.join(', ')} is null. ` +
        'PrepareNode must run before CycleNode.',
    );
  }
}

// ============================================================================
// Node Implementations
// ============================================================================

/**
 * Initializes the tool-use agent run.
 *
 * Uses PocketFlow's native error handling:
 * - exec(): Let errors throw naturally (no try/catch)
 * - execFallback(): Convert errors to result type for post()
 * - Node with maxRetries=1: No retry, just fallback on error
 */
class ToolUseInitNode<C> extends Node<ToolUseRunShared<C>> {
  constructor() {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: ToolUseRunShared<C>) {
    return { hooks: shared.hooks, lifecycle: shared.lifecycle };
  }

  async exec(prepRes: {
    hooks: ToolUseRunHooks<C>;
    lifecycle: ToolUseRunLifecycle;
  }): Promise<{ kind: 'success' }> {
    prepRes.lifecycle.begin('init');
    // Let errors throw - Node._exec catches them and calls execFallback
    const runStage = await prepRes.hooks.start();
    await prepRes.hooks.init(runStage);
    await prepRes.hooks.initializeClient();
    return { kind: 'success' };
  }

  async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<{ kind: 'error'; error: unknown }> {
    return { kind: 'error', error };
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: unknown,
    execRes: InitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      shared.lifecycle.fail(execRes.error);
      return FlowTransition.FINALIZE;
    }
    shared.lifecycle.begin('prepare');
    return undefined; // Follow next() → PrepareNode
  }
}

/**
 * Prepares state for tool-use cycle.
 *
 * Uses PocketFlow's native error handling:
 * - exec(): Let errors throw naturally (no try/catch)
 * - execFallback(): Convert errors to result type for post()
 */
class ToolUsePrepareNode<C> extends Node<ToolUseRunShared<C>> {
  constructor() {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(
    shared: ToolUseRunShared<C>,
  ): Promise<ToolUsePrepareNodePrepResult<C>> {
    // Pure extraction - no side effects
    return { hooks: shared.hooks };
  }

  async exec(
    prepRes: ToolUsePrepareNodePrepResult<C>,
  ): Promise<{ kind: 'success'; result: ToolUsePrepareResult<C> }> {
    // Let errors throw - Node._exec catches them and calls execFallback
    const prepared = await prepRes.hooks.prepareState();
    const cycleOptions = prepRes.hooks.buildCycleOptions(prepared.store);
    return {
      kind: 'success',
      result: {
        ...prepared,
        cycleOptions,
      } satisfies ToolUsePrepareResult<C>,
    };
  }

  async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<{ kind: 'error'; error: unknown }> {
    return { kind: 'error', error };
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUsePrepareNodePrepResult<C>,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      shared.lifecycle.fail(execRes.error);
      return FlowTransition.FINALIZE;
    }

    const { messages, store, shouldSkipCycle, cycleOptions } = execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    shared.state.store = store;

    // Note: CycleNode owns 'cycle' phase transition
    return undefined; // Follow next() → CycleNode
  }
}

/**
 * Runs a single tool-use cycle.
 *
 * PocketFlow compliance:
 * - prep(): Extract immutable data from shared state
 * - exec(): Pure computation (call runCycle, no side effects)
 * - post(): Side effects (persist checkpoint) + routing decision
 */
class ToolUseCycleNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<CycleNodePrepResult<C>> {
    // Own our phase - CycleNode is responsible for 'cycle' lifecycle phase
    // (minor bookkeeping side effect, acceptable in prep)
    shared.lifecycle.begin('cycle');

    // Validate invariant: PrepareNode must have run before us
    assertPreparedState(shared.state);

    return {
      shouldSkip: shared.state.shouldSkipCycle,
      cycleOptions: shared.state.cycleOptions,
      conversation: shared.state.conversation,
      store: shared.state.store,
      hooks: shared.hooks,
    };
  }

  async exec(prepRes: CycleNodePrepResult<C>): Promise<CycleExecResult> {
    // Handle skip (resume case) - pure decision, no side effects
    if (prepRes.shouldSkip) {
      return { kind: 'skipped' };
    }

    // Pure: call the cycle, return result
    const result = await prepRes.hooks.runCycle(
      prepRes.cycleOptions,
      prepRes.conversation,
      prepRes.store,
    );

    if (result.failedWithError) {
      return { kind: 'failed', message: result.errorMessage ?? 'Cycle failed' };
    }
    if (result.userCancelled) {
      return { kind: 'cancelled' };
    }
    return { kind: 'success' };
  }

  async post(
    shared: ToolUseRunShared<C>,
    prepRes: CycleNodePrepResult<C>,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    // Clear skip flag for next iteration (side effect in post)
    if (prepRes.shouldSkip) {
      shared.state.shouldSkipCycle = false;
    }

    switch (execRes.kind) {
      case 'success':
        // Persist checkpoint (side effect belongs in post)
        // Use prepRes.store which was validated in prep()
        await shared.hooks.persistCheckpoint(
          shared.state.conversation,
          prepRes.store,
        );
        return undefined; // Follow next() → WaitNode

      case 'skipped':
        return undefined; // Follow next() → WaitNode

      case 'failed':
        shared.lifecycle.fail(new Error(execRes.message));
        return FlowTransition.FINALIZE;

      case 'cancelled':
        // User cancelled - not an error, just finalize
        return FlowTransition.FINALIZE;
    }
  }
}

/**
 * Waits for user follow-up message between cycles.
 *
 * PocketFlow compliance:
 * - prep(): I/O operations (waiting is I/O, OK in prep)
 * - exec(): Pure transformation of prep result
 * - post(): Side effects (apply follow-up) + routing decision
 *
 * Flow-control methods called directly on agent (like ReflectionRoundNode pattern).
 * Uses CONTINUE transition to loop back to CycleNode.
 */
class ToolUseWaitNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<WaitNodePrepResult> {
    const { agent } = shared;

    // Check interruption first (direct agent call)
    if (agent.isInterruptionRequested()) {
      return { interrupted: true };
    }

    // Handle waiting state (I/O - OK in prep)
    if (agent.hasQueuedFollowUp()) {
      await agent.clearPersistedSnapshot();
    } else {
      await agent.enterWaitingState();
    }

    // Wait for follow-up (blocking I/O - OK in prep, direct agent call)
    const followUp = await agent.waitForFollowUp();

    if (!followUp || agent.isInterruptionRequested()) {
      return { interrupted: true };
    }

    return { interrupted: false, followUp };
  }

  async exec(prepRes: WaitNodePrepResult): Promise<WaitExecResult> {
    // Pure: just transform prep result to exec result
    if (prepRes.interrupted) {
      return { kind: 'stop', reason: 'interrupted' };
    }
    if (!prepRes.followUp) {
      return { kind: 'stop', reason: 'no-followup' };
    }
    return { kind: 'continue', followUp: prepRes.followUp };
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: WaitNodePrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      return FlowTransition.FINALIZE;
    }

    // Apply follow-up (side effects belong in post, direct agent call)
    await shared.agent.markRunning();
    await shared.agent.clearPersistedSnapshot();
    shared.state.conversation = await shared.agent.applyFollowUpMessage(
      execRes.followUp,
      shared.state.conversation,
    );

    // Loop back to CycleNode (like ReflectionRoundNode uses CONTINUE)
    return FlowTransition.CONTINUE;
  }
}

/** Context type for ToolUseFinalizeNode hooks */
type ToolUseFinalizeContext<C> = FinalizeContext<
  ToolUseRunLifecycle,
  ToolUseRunHooks<C>,
  BaseToolUseAgent<C>
>;

/**
 * Finalize node for tool-use runs.
 * Clears persisted snapshot before ending.
 */
class ToolUseFinalizeNode<C> extends StandardFinalizeNode<ToolUseRunShared<C>> {
  constructor() {
    super('finalize');
  }

  protected async beforeEnd(context: ToolUseFinalizeContext<C>): Promise<void> {
    // Direct agent call (like WaitNode pattern)
    await context.agent.clearPersistedSnapshot();
  }
}

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  // Create all nodes
  const initNode = new ToolUseInitNode<C>();
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const waitNode = new ToolUseWaitNode<C>();
  const finalizeNode = new ToolUseFinalizeNode<C>();

  // Wire using native PocketFlow API
  // Linear flow (happy path): init → prepare → cycle → wait
  initNode.next(prepareNode);
  prepareNode.next(cycleNode);
  cycleNode.next(waitNode);

  // Branches: error paths → finalize, loop → cycle
  initNode.on(FlowTransition.FINALIZE, finalizeNode);
  prepareNode.on(FlowTransition.FINALIZE, finalizeNode);
  cycleNode.on(FlowTransition.FINALIZE, finalizeNode);
  waitNode.on(FlowTransition.CONTINUE, cycleNode);
  waitNode.on(FlowTransition.FINALIZE, finalizeNode);

  return new Flow<ToolUseRunShared<C>>(initNode);
}
