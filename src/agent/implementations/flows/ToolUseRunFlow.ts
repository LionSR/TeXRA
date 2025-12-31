/**
 * ToolUseRunFlow - PocketFlow implementation for tool-use agents.
 *
 * Architecture:
 * - Agent = Service Provider (provides services via getter)
 * - Flow = Execution Engine (all logic lives here)
 * - Nodes = Discrete Operations (use this.services natively)
 *
 * Service injection:
 * - Services are set via flow.setServices() (not hooks in shared)
 * - Flow propagates services to all nodes automatically
 * - Nodes access via this.services getter
 *
 * This follows the same pattern as ReflectionFlow for consistency.
 */

// Local imports - core flow primitives
import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState } from '@agent/core/AgentState';

// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';

// Internal imports
import {
  type NodeExecResult,
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';

// Service types
import type { ToolUseServices, ToolUseFlowParams } from './tooluse';

// ============================================================================
// State Types
// ============================================================================

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
 * Create initial state for a tool-use flow run.
 *
 * Factory function for consistency with ReflectionFlow pattern
 * (which uses createInitialReflectionState).
 */
export function createInitialToolUseState<C = unknown>(): ToolUseRunState<C> {
  return {
    conversation: [],
    cycleOptions: null,
    shouldSkipCycle: false,
    store: null,
    runState: new AgentRunState(),
  };
}

/**
 * Shared context passed through the flow.
 *
 * Contains only mutable runtime state. All dependencies (session, interruption
 * checking, etc.) are accessed via this.services - NOT via shared.
 *
 * Note: Agent owns lifecycle (init/finalize in agent.run() try/finally).
 * Work nodes use services from this.services, throw errors on failure.
 */
export interface ToolUseRunShared<C = unknown> {
  state: ToolUseRunState<C>;
  /** Index signature for PersistedFlow serialization compatibility */
  [key: string]: unknown;
}

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
 * Prep result for ToolUseCycleNode.
 */
interface CycleNodePrepResult<C> {
  shouldSkip: boolean;
  cycleOptions: ToolUseCycleOptions<C>;
  conversation: ProviderMessage[];
  store: AgentSharedStore;
}

/**
 * Prep result for ToolUseWaitNode.
 * Contains only the data needed to execute the wait operation.
 */
interface WaitNodePrepResult {
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
 * Uses native services pattern:
 * - this.services.prepareState() instead of shared.hooks.prepareState()
 * - this.services.buildCycleOptions() instead of shared.hooks.buildCycleOptions()
 */
class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared<C>,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(_shared: ToolUseRunShared<C>): Promise<void> {
    // No prep needed - services accessed via this.services
  }

  async exec(
    _prepRes: void,
  ): Promise<{ kind: 'success'; result: ToolUsePrepareResult<C> }> {
    // Use native services pattern
    const prepared = await this.services.prepareState();
    const cycleOptions = this.services.buildCycleOptions(prepared.store);
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
    _prepRes: void,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      // Throw error - agent.run() catches and handles cleanup
      throw execRes.error instanceof Error
        ? execRes.error
        : new Error(String(execRes.error));
    }

    const { messages, store, shouldSkipCycle, cycleOptions, runState } =
      execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    shared.state.store = store;
    shared.state.runState = runState;

    return FlowTransition.DEFAULT; // Follow next() → CycleNode
  }
}

/**
 * Runs a single tool-use cycle.
 *
 * Uses native services pattern:
 * - this.services.runCycle() instead of shared.hooks.runCycle()
 *
 * Note: PersistedFlow handles checkpoint persistence automatically after each node.
 */
class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared<C>,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ToolUseRunShared<C>): Promise<CycleNodePrepResult<C>> {
    // Validate invariant: PrepareNode must have run before us
    assertPreparedState(shared.state);

    return {
      shouldSkip: shared.state.shouldSkipCycle,
      cycleOptions: shared.state.cycleOptions,
      conversation: shared.state.conversation,
      store: shared.state.store,
    };
  }

  async exec(prepRes: CycleNodePrepResult<C>): Promise<CycleExecResult> {
    // Handle skip (resume case) - pure decision, no side effects
    if (prepRes.shouldSkip) {
      return { kind: 'skipped' };
    }

    // Use native services pattern
    const result = await this.services.runCycle(
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
      case 'skipped':
        // PersistedFlow handles checkpoint persistence automatically after each node
        return FlowTransition.DEFAULT; // Follow next() → WaitNode

      case 'failed':
        // Throw error - agent.run() catches and handles cleanup
        throw new Error(execRes.message);

      case 'cancelled':
        // User cancelled - not an error, flow ends gracefully
        // Return FINALIZE to exit flow (no finalize successor = flow ends)
        return FlowTransition.FINALIZE;
    }
  }
}

/**
 * Waits for user follow-up message between cycles.
 *
 * Uses native services pattern:
 * - this.services.applyFollowUpMessage() instead of shared.agent.applyFollowUpMessage()
 * - Session operations via this.services.session
 */
class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared<C>,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ToolUseRunShared<C>): Promise<WaitNodePrepResult> {
    const session = this.services.session;
    return {
      conversation: shared.state.conversation,
      hasQueuedFollowUp: session.hasQueuedFollowUp(),
      session,
    };
  }

  async exec(prepRes: WaitNodePrepResult): Promise<WaitExecResult> {
    const { hasQueuedFollowUp, session } = prepRes;

    // Check interruption first
    if (this.services.checkInterruption()) {
      return { kind: 'stop', reason: 'interrupted' };
    }

    // Enter waiting state if no queued follow-up
    // PersistedFlow handles state persistence automatically
    if (!hasQueuedFollowUp) {
      await session.enterWaitingState();
    }

    // Wait for follow-up (blocking I/O)
    const checkInterruption = this.services.checkInterruption;
    const followUp = await session.waitForFollowUp(checkInterruption);

    if (!followUp || checkInterruption()) {
      return { kind: 'stop', reason: 'interrupted' };
    }

    return { kind: 'continue', followUp };
  }

  async execFallback(
    _prepRes: WaitNodePrepResult,
    error: Error,
  ): Promise<WaitExecResult> {
    // Convert error to stop result - post() will handle finalization
    this.services.logger.error(
      `ToolUseWaitNode error during wait: ${error.message}`,
    );
    return { kind: 'stop', reason: 'interrupted' };
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: WaitNodePrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      // No follow-up or interrupted - flow ends gracefully
      return FlowTransition.DEFAULT;
    }

    // Apply follow-up via services
    const session = this.services.session;
    await session.markRunning();
    shared.state.conversation = await this.services.applyFollowUpMessage(
      execRes.followUp,
      shared.state.conversation,
    );

    // Loop back to CycleNode
    return FlowTransition.CONTINUE;
  }
}

// ============================================================================
// Flow Factory
// ============================================================================

/**
 * Creates a tool-use flow with native services support.
 *
 * Architecture:
 * - Agent owns lifecycle (init before flow, finalize in finally)
 * - Flow is pure execution (prepare → cycle → wait loop)
 * - Errors throw directly; agent.run() catches and handles cleanup
 *
 * Usage:
 * ```typescript
 * const flow = createToolUseRunFlow<C>();
 * flow.setServices(agent.services);
 * await flow.run(shared);
 * ```
 */
export function createToolUseRunFlow<C = unknown>(): Flow<
  ToolUseRunShared<C>,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  // Create work nodes (no init/finalize - agent owns lifecycle)
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const waitNode = new ToolUseWaitNode<C>();

  // Wire using native PocketFlow API
  // Linear flow: prepare → cycle → wait (loop back via CONTINUE)
  prepareNode.next(cycleNode);
  cycleNode.next(waitNode);
  waitNode.on(FlowTransition.CONTINUE, cycleNode);

  return new Flow<ToolUseRunShared<C>, ToolUseFlowParams, ToolUseServices<C>>(
    prepareNode,
  );
}

// Re-export types for convenience
export type { ToolUseServices, ToolUseFlowParams } from './tooluse';
