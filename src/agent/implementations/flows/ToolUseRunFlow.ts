// Local imports - core flow primitives
import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState } from '@agent/core/AgentState';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IFlowAgent } from '@agent/core/IAgent';
import type { IToolUseSession } from '@agent/toolUse/ToolUseSessionLifecycle';
// Internal imports
import {
  StandardFinalizeNode,
  StandardInitNode,
  AgentLifecycle,
  type AgentRunShared,
  type FinalizeContext,
  type NodeExecResult,
} from '@agent/implementations/flows/common';

// ============================================================================
// Phase Definitions
// ============================================================================

/**
 * Tool use run phase - single source of truth for tool-use agent flow phases.
 */
const TOOL_USE_RUN_PHASE = {
  IDLE: 'idle',
  INIT: 'init',
  PREPARE: 'prepare',
  CYCLE: 'cycle',
  FINALIZE: 'finalize',
} as const;

export type ToolUseRunPhase =
  (typeof TOOL_USE_RUN_PHASE)[keyof typeof TOOL_USE_RUN_PHASE];

export type ToolUseRunLifecycle = AgentLifecycle<ToolUseRunPhase>;

/**
 * Flow-specific hooks for tool-use agent runs.
 *
 * Lifecycle methods (startRun, initRun, endRun, cleanupRun) are on IFlowAgent.
 * Session lifecycle methods (waitForFollowUp, clearPersistedSnapshot, etc.)
 * are on IToolUseFlowAgent.
 *
 * This interface contains only flow-specific hooks that vary by implementation.
 */
export interface ToolUseRunHooks<C = unknown> {
  prepareState(): Promise<{
    messages: ProviderMessage[];
    store: AgentSharedStore;
    shouldSkipCycle: boolean;
    runState: AgentRunState;
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
 */
export interface ToolUseRunState<C = unknown> {
  conversation: ProviderMessage[];
  cycleOptions: ToolUseCycleOptions<C> | null;
  shouldSkipCycle: boolean;
  store: AgentSharedStore | null;
  runState: AgentRunState;
}

/**
 * Interface for agents used by ToolUseRunFlow.
 *
 * This interface captures the minimal contract that tool-use flows depend on,
 * decoupling flow implementation from concrete agent classes.
 *
 * Session lifecycle operations are exposed via the `session` property,
 * following composition over delegation pattern.
 */
export interface IToolUseFlowAgent extends IFlowAgent {
  /** Session lifecycle operations (follow-ups, persistence, status). */
  readonly session: IToolUseSession;

  /** Apply a follow-up message to the conversation. */
  applyFollowUpMessage(
    message: string,
    conversation: ProviderMessage[],
  ): Promise<ProviderMessage[]>;
}

/**
 * Shared state for tool-use runs.
 *
 * Extends AgentRunShared with required hooks (not optional).
 * ToolUseRunFlow requires hooks for prepareState, buildCycleOptions, etc.
 */
export type ToolUseRunShared<C = unknown> = AgentRunShared<
  IToolUseFlowAgent,
  ToolUseRunState<C>,
  ToolUseRunLifecycle,
  ToolUseRunHooks<C>
> & {
  hooks: ToolUseRunHooks<C>; // Override to required
};

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
  runState: AgentRunState;
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
  lifecycle: ToolUseRunLifecycle;
}

/**
 * Prep result for ToolUseWaitNode.
 * Contains only the data needed to execute the wait operation.
 */
interface WaitNodePrepResult {
  agent: IToolUseFlowAgent;
  conversation: ProviderMessage[];
  hasQueuedFollowUp: boolean;
  session: IToolUseSession;
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
 * Asserts that state has been prepared (cycleOptions and store are non-null).
 * Called by CycleNode to ensure PrepareNode has run before entering cycle.
 *
 * This provides:
 * - Type narrowing (removes `| null` from types)
 * - Fail-fast with descriptive error if flow invariant is violated
 * - Documentation of the PrepareNode → CycleNode contract
 */
function assertPreparedState<C>(
  state: ToolUseRunState<C>,
): asserts state is PreparedState<C> {
  if (state.cycleOptions === null || state.store === null) {
    throw new Error(
      'CycleNode invariant violated: PrepareNode must run before CycleNode.',
    );
  }
}

// ============================================================================
// Node Implementations
// ============================================================================

/**
 * Prepares state for tool-use cycle.
 *
 * Phase ownership: Inherits 'prepare' phase from InitNode.post().
 * Does not transition phases - stays in 'prepare' throughout.
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

    const { messages, store, shouldSkipCycle, cycleOptions, runState } =
      execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    shared.state.store = store;
    shared.state.runState = runState;

    return undefined; // Follow next() → CycleNode
  }
}

/**
 * Runs a single tool-use cycle.
 *
 * Phase ownership:
 * - exec(): Sets 'cycle' phase at start of work (consistent with StandardInitNode)
 *
 * PocketFlow compliance:
 * - prep(): Extract immutable data from shared state
 * - exec(): Set phase + call runCycle (I/O acceptable for lifecycle tracking)
 * - execFallback(): Convert thrown errors to result type
 * - post(): Side effects (persist checkpoint) + routing decision
 */
class ToolUseCycleNode<C> extends Node<ToolUseRunShared<C>> {
  constructor() {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: ToolUseRunShared<C>): Promise<CycleNodePrepResult<C>> {
    // Validate invariant: PrepareNode must have run before us
    assertPreparedState(shared.state);

    return {
      shouldSkip: shared.state.shouldSkipCycle,
      cycleOptions: shared.state.cycleOptions,
      conversation: shared.state.conversation,
      store: shared.state.store,
      hooks: shared.hooks,
      lifecycle: shared.lifecycle,
    };
  }

  async exec(prepRes: CycleNodePrepResult<C>): Promise<CycleExecResult> {
    // Set phase at start of work (consistent with StandardInitNode pattern)
    prepRes.lifecycle.begin('cycle');

    // Handle skip (resume case) - pure decision, no side effects
    if (prepRes.shouldSkip) {
      return { kind: 'skipped' };
    }

    // Call the cycle, return result
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

  async execFallback(
    _prepRes: CycleNodePrepResult<C>,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'failed', message: error.message };
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
 * Phase ownership: None (stays in 'cycle' phase during wait)
 *
 * PocketFlow compliance:
 * - prep(): Pure data extraction from shared state
 * - exec(): I/O operations (entering wait state, waiting for follow-up)
 * - execFallback(): Convert errors to result type for post()
 * - post(): Side effects (apply follow-up) + routing decision
 *
 * Flow-control methods called directly on agent (like ReflectionRoundNode pattern).
 * Uses CONTINUE transition to loop back to CycleNode.
 */
class ToolUseWaitNode<C> extends Node<ToolUseRunShared<C>> {
  constructor() {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: ToolUseRunShared<C>): Promise<WaitNodePrepResult | null> {
    // Pure extraction - no side effects
    // Wrap in try/catch since prep() errors aren't caught by execFallback()
    try {
      return {
        agent: shared.agent,
        conversation: shared.state.conversation,
        hasQueuedFollowUp: shared.agent.session.hasQueuedFollowUp(),
        session: shared.agent.session,
      };
    } catch (error) {
      console.error('ToolUseWaitNode prep error:', error);
      return null;
    }
  }

  async exec(prepRes: WaitNodePrepResult | null): Promise<WaitExecResult> {
    // Handle prep failure
    if (!prepRes) {
      return { kind: 'stop', reason: 'interrupted' };
    }

    const { agent, conversation, hasQueuedFollowUp, session } = prepRes;

    // Check interruption first
    if (agent.isInterruptionRequested()) {
      return { kind: 'stop', reason: 'interrupted' };
    }

    // Handle waiting state (I/O in exec where errors are caught)
    if (hasQueuedFollowUp) {
      await session.clearPersistedSnapshot();
    } else {
      await session.enterWaitingState(conversation);
    }

    // Wait for follow-up (blocking I/O)
    const followUp = await session.waitForFollowUp(() =>
      agent.isInterruptionRequested(),
    );

    if (!followUp || agent.isInterruptionRequested()) {
      return { kind: 'stop', reason: 'interrupted' };
    }

    return { kind: 'continue', followUp };
  }

  async execFallback(
    _prepRes: WaitNodePrepResult | null,
    error: Error,
  ): Promise<WaitExecResult> {
    // Convert error to stop result - post() will handle finalization
    // Log the error for debugging but don't propagate it
    console.error('ToolUseWaitNode error during wait:', error.message);
    return { kind: 'stop', reason: 'interrupted' };
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: WaitNodePrepResult | null,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      return FlowTransition.FINALIZE;
    }

    // Apply follow-up (side effects belong in post, direct agent call)
    await shared.agent.session.markRunning();
    await shared.agent.session.clearPersistedSnapshot();
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
  IToolUseFlowAgent
>;

/**
 * Finalize node for tool-use runs.
 * Clears persisted snapshot before ending.
 *
 * Phase ownership: StandardFinalizeNode.prep() sets 'finalize' phase.
 */
class ToolUseFinalizeNode<C> extends StandardFinalizeNode<ToolUseRunShared<C>> {
  constructor() {
    super('finalize');
  }

  protected async beforeEnd(context: ToolUseFinalizeContext<C>): Promise<void> {
    // Direct session call
    await context.agent.session.clearPersistedSnapshot();
  }
}

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  // Create all nodes
  const initNode = new StandardInitNode<ToolUseRunShared<C>>('prepare');
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
