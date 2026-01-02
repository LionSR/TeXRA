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
import {
  AgentSharedStore,
  createSharedStore,
  type AgentSharedStoreSnapshot,
} from '@agent/core/AgentSharedStore';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
  type ToolUseCycleState,
} from '@agent/core/flows/ToolUseCycleFlow';
import { createRetryState } from '@agent/core/flows/RetryState';
import { interpretCycleCompletion } from '@agent/core/flows/CommonCycleTypes';

// Type imports
import type { ToolUseCycleOptions } from '@agent/core/flows/CycleServices';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import type { TodoItem } from '@eventBus/schemas';
import { bus } from '@eventBus/ProgressEventBus';

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
 *
 * Following koala-code-reader pattern: stores **snapshots** (plain JSON objects)
 * instead of class instances. This ensures structuredClone() works correctly
 * when PersistedFlow serializes the state.
 *
 * - storeSnapshot: AgentSharedStoreSnapshot (not AgentSharedStore class)
 * - Nodes reconstruct class instances from snapshots when needed
 *
 * IMPORTANT: cycleOptions is NOT stored here because it contains non-serializable
 * objects (modelHandler, client, logger, functions). It's rebuilt each cycle from services.
 */
export interface ToolUseRunState {
  conversation: ProviderMessage[];
  shouldSkipCycle: boolean;
  /** Store snapshot (natively serializable) - reconstruct via createSharedStore() */
  storeSnapshot: AgentSharedStoreSnapshot | null;
}

/**
 * Create initial state for a tool-use flow run.
 *
 * Factory function for consistency with ReflectionFlow pattern
 * (which uses createInitialReflectionState).
 */
export function createInitialToolUseState(): ToolUseRunState {
  return {
    conversation: [],
    shouldSkipCycle: false,
    storeSnapshot: null,
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
export interface ToolUseRunShared {
  state: ToolUseRunState;
  /** Index signature for PersistedFlow serialization compatibility */
  [key: string]: unknown;
}

// ============================================================================
// Result Types - Clean discriminated unions following PocketFlow patterns
// ============================================================================

/**
 * Result of prepare execution.
 * Note: cycleOptions is only used within the same node (exec → post),
 * NOT persisted to state (non-serializable).
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

/** Prepared state type with non-null storeSnapshot. */
type PreparedState = ToolUseRunState & {
  storeSnapshot: AgentSharedStoreSnapshot;
};

/**
 * Asserts that state has been prepared (storeSnapshot is non-null).
 * Called by CycleNode to ensure PrepareNode has run before entering cycle.
 */
function assertPreparedState(
  state: ToolUseRunState,
): asserts state is PreparedState {
  if (state.storeSnapshot === null) {
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
 *
 * Note: cycleOptions is NOT stored in state (non-serializable). It's rebuilt
 * by CycleNode using this.services.buildCycleOptions().
 */
class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(_shared: ToolUseRunShared): Promise<void> {
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
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      // Throw error - agent.run() catches and handles cleanup
      throw execRes.error instanceof Error
        ? execRes.error
        : new Error(String(execRes.error));
    }

    const { messages, store, shouldSkipCycle } = execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    // Store snapshot instead of class instance (for PersistedFlow serialization)
    // cycleOptions is NOT stored - it's rebuilt from services in CycleNode
    shared.state.storeSnapshot = store.toSnapshot();

    return FlowTransition.DEFAULT; // Follow next() → CycleNode
  }
}

/**
 * Runs a single tool-use cycle.
 *
 * Creates and runs ToolUseCycleFlow directly in exec() (like ResponseCycleNode).
 * Flow is created fresh each execution to avoid stale state.
 *
 * Note: PersistedFlow handles checkpoint persistence automatically after each node.
 */
class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ToolUseRunShared): Promise<CycleNodePrepResult<C>> {
    // Validate invariant: PrepareNode must have run before us
    assertPreparedState(shared.state);

    // Reconstruct store from snapshot (koala-code-reader pattern)
    const store = createSharedStore({ snapshot: shared.state.storeSnapshot });

    // Rebuild cycleOptions from services (NOT stored in state - non-serializable)
    const cycleOptions = this.services.buildCycleOptions(store);

    return {
      shouldSkip: shared.state.shouldSkipCycle,
      cycleOptions,
      conversation: shared.state.conversation,
      store,
    };
  }

  async exec(prepRes: CycleNodePrepResult<C>): Promise<CycleExecResult> {
    // Handle skip (resume case) - pure decision, no side effects
    if (prepRes.shouldSkip) {
      return { kind: 'skipped' };
    }

    // Create cycle shared state (like ResponseCycleNode)
    // Tool-use cycles track metrics in state (cycleIndex, etc.) instead of round object
    // cycleIndex starts from run.totalRounds to maintain continuity across user follow-ups
    const cycleShared: ToolUseCycleShared = {
      state: {
        messages: prepRes.conversation,
        shouldStop: false,
        response: undefined,
        responseTimeMs: undefined,
        toolCalls: undefined,
        text: undefined,
        stopReason: undefined,
        cycleIndex: prepRes.store.run.totalRounds,
        cycleResponseTimeMs: 0,
        cycleNormalizedUsage: undefined,
        endTurn: false,
      } satisfies ToolUseCycleState,
      retryState: createRetryState(),
    };

    // Create and run the flow directly (like ResponseCycleNode)
    // Note: Tool-use cycles track metrics in flow state (cycleIndex, etc.)
    // instead of a round object, so we only pass run/workspace/onRoundFinalized.
    const flow = createToolUseCycleFlow<C>();
    const onRoundFinalized = this.services.getUsageRecorder();
    flow.setServices({
      ...prepRes.cycleOptions,
      run: prepRes.store.run,
      workspace: prepRes.store.workspace,
      onRoundFinalized,
    });

    // Set up todo update callback to emit changes to the progress view
    const { context } = this.services;
    prepRes.store.workspace.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', {
        stream: context.streamId,
        executionId: context.executionId,
        todos,
      });
    });

    try {
      await flow.run(cycleShared);

      // Interpret cycle completion using shared helper
      const completion = interpretCycleCompletion(
        cycleShared.state,
        cycleShared.retryState,
      );

      if (completion.failedWithError) {
        return {
          kind: 'failed',
          message: completion.errorMessage ?? 'Cycle failed',
        };
      }
      if (completion.userCancelled) {
        return { kind: 'cancelled' };
      }
      return { kind: 'success' };
    } catch (error) {
      return {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Clear the todo update callback to prevent memory leaks
      prepRes.store.workspace.todos.clearOnUpdate();
    }
  }

  async execFallback(
    _prepRes: CycleNodePrepResult<C>,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'failed', message: error.message };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CycleNodePrepResult<C>,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    // Clear skip flag for next iteration (side effect in post)
    if (prepRes.shouldSkip) {
      shared.state.shouldSkipCycle = false;
    }

    // Update store snapshot after cycle (cycle mutates the store)
    // This ensures workspace state changes (todos, interactions, etc.) are persisted
    shared.state.storeSnapshot = prepRes.store.toSnapshot();

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
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  async prep(shared: ToolUseRunShared): Promise<WaitNodePrepResult> {
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
    shared: ToolUseRunShared,
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
  ToolUseRunShared,
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

  return new Flow<ToolUseRunShared, ToolUseFlowParams, ToolUseServices<C>>(
    prepareNode,
  );
}

// Re-export types for convenience
export type { ToolUseServices, ToolUseFlowParams } from './tooluse';
