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
 * Refactored (no closure wrappers):
 * - Nodes call helper functions directly with services context
 * - Eliminates closure indirection for cleaner call stacks
 *
 * This follows the same pattern as ReflectionFlow for consistency.
 */

// Local imports - core flow primitives
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

// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import {
  type NodeExecResult,
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import { buildInitialToolUsePrompts } from '@utils/prompt';
import type { TodoItem } from '@eventBus/schemas';
import { bus } from '@eventBus/ProgressEventBus';

// Service types
import { type ToolUseServices, type ToolUseFlowParams } from './tooluse';

// ============================================================================
// State Types
// ============================================================================

/**
 * Snapshot of state slices for persistence.
 *
 * Stores individual snapshots instead of bundling in AgentSharedStoreSnapshot.
 * This eliminates the AgentSharedStore wrapper overhead (convert→pass→convert pattern).
 */
interface StateSlicesSnapshot {
  runStateSnapshot: AgentRunStateSnapshot;
  workspaceSnapshot: AgentWorkspaceSnapshot;
  userChannels: UserVariableChannels;
}

/**
 * Runtime state for tool-use agent runs.
 *
 * Following koala-code-reader pattern: stores **snapshots** (plain JSON objects)
 * instead of class instances. This ensures structuredClone() works correctly
 * when PersistedFlow serializes the state.
 *
 * State slices are stored individually (no AgentSharedStore wrapper):
 * - runStateSnapshot: Run-level statistics and usage
 * - workspaceSnapshot: Workspace state (todos, interactions, etc.)
 * - userChannels: User variable channels
 *
 * Nodes reconstruct class instances from snapshots when needed.
 *
 * IMPORTANT: cycleOptions is NOT stored here because it contains non-serializable
 * objects (modelHandler, client, logger, functions). It's rebuilt each cycle from services.
 */
export interface ToolUseRunState {
  conversation: ProviderMessage[];
  shouldSkipCycle: boolean;
  /** State slices (natively serializable) - reconstruct via fromSnapshot() */
  stateSlices: StateSlicesSnapshot | null;
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
}

// ============================================================================
// Result Types - Clean discriminated unions following PocketFlow patterns
// ============================================================================

/**
 * Result of prepare execution.
 *
 * Contains individual state slices directly (no AgentSharedStore wrapper).
 */
interface ToolUsePrepareResult {
  messages: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  shouldSkipCycle: boolean;
}

type ToolUsePrepareExecResult = NodeExecResult<ToolUsePrepareResult>;

/**
 * Result of a single cycle execution.
 * Uses 'kind' discriminant for clarity (matches PocketFlow's InvocationResult).
 */
type CycleExecResult =
  | { kind: 'success'; messages: ProviderMessage[] }
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
 *
 * Contains individual state slices directly (no AgentSharedStore wrapper).
 */
interface CycleNodePrepResult {
  shouldSkip: boolean;
  conversation: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

/**
 * Prep result for ToolUseWaitNode.
 * PocketFlow compliance: prep() extracts state, exec() does blocking I/O.
 *
 * Note: session is NOT passed through prepRes - access via this.services instead.
 */
interface WaitNodePrepResult {
  /** Whether the wait was interrupted before it started */
  interrupted: boolean;
}

// ============================================================================
// State Guards
// ============================================================================

/** Prepared state type with non-null stateSlices. */
type PreparedState = ToolUseRunState & {
  stateSlices: StateSlicesSnapshot;
};

/**
 * Asserts that state has been prepared (stateSlices is non-null).
 * Called by CycleNode to ensure PrepareNode has run before entering cycle.
 */
function assertPreparedState(
  state: ToolUseRunState,
): asserts state is PreparedState {
  if (state.stateSlices === null) {
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
 * PocketFlow compliance:
 * - prep(): Empty because there's no shared state to extract (initial run)
 * - exec(): Calls helper functions via this.services (allowed - services are immutable)
 * - post(): Applies all state mutations (conversation, storeSnapshot)
 *
 * Note: This node's prep() is intentionally empty because:
 * 1. On first run, shared.state is empty (no data to extract)
 * 2. All initialization happens via this.services, not shared state
 * 3. The work done in exec() uses services, not shared state access
 *
 * Cycle options are NOT stored in state (non-serializable). CycleNode
 * spreads parent services directly when creating the cycle flow.
 */
class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  /**
   * No preparation needed - this is the initial node with empty shared state.
   * All data comes from services, not shared state.
   */
  async prep(_shared: ToolUseRunShared): Promise<void> {
    // No prep needed - shared state is empty on first run
    // Services accessed via this.services in exec()
  }

  async exec(
    _prepRes: void,
  ): Promise<{ kind: 'success'; result: ToolUsePrepareResult }> {
    const { modelHandler, prompt, userVarChannels, logger, snapshot } =
      this.services;

    // Resume from snapshot if available
    if (snapshot) {
      logger.debug('Resuming tool-use session from saved state.');
      const runState = AgentRunState.fromSnapshot(snapshot.run);
      const workspaceState = AgentWorkspaceState.fromSnapshot(
        snapshot.workspace,
      );
      const userChannels = {
        input: Object.freeze({ ...snapshot.user.input }),
        transient: { ...snapshot.user.transient },
      };
      return {
        kind: 'success',
        result: {
          messages: snapshot.messages,
          runState,
          workspaceState,
          userChannels,
          shouldSkipCycle: true,
        },
      };
    }

    // Create fresh state for new sessions
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
        {
          memoryEnabled,
        },
      );

    const messages = await modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemPrompt
        ? `${systemPrompt}\n${instructionSuffix}`
        : instructionSuffix,
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
    execRes: ToolUsePrepareExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      // Throw error - agent.run() catches and handles cleanup
      throw execRes.error instanceof Error
        ? execRes.error
        : new Error(String(execRes.error));
    }

    const {
      messages,
      runState,
      workspaceState,
      userChannels,
      shouldSkipCycle,
    } = execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    // Store individual snapshots instead of bundled AgentSharedStoreSnapshot
    // This eliminates the AgentSharedStore wrapper overhead
    shared.state.stateSlices = {
      runStateSnapshot: runState.toSnapshot(),
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels,
    };

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

  /** Emit todos update event to progress view. */
  private emitTodosUpdate(todos: TodoItem[]): void {
    bus.emit('updateTodos', {
      stream: this.services.streamId,
      executionId: this.services.executionId,
      todos,
    });
  }

  async prep(shared: ToolUseRunShared): Promise<CycleNodePrepResult> {
    // Validate invariant: PrepareNode must have run before us
    assertPreparedState(shared.state);

    // Reconstruct state slices directly from snapshots (no store wrapper)
    const { stateSlices } = shared.state;
    const runState = AgentRunState.fromSnapshot(stateSlices.runStateSnapshot);
    const workspaceState = AgentWorkspaceState.fromSnapshot(
      stateSlices.workspaceSnapshot,
    );

    return {
      shouldSkip: shared.state.shouldSkipCycle,
      conversation: shared.state.conversation,
      runState,
      workspaceState,
      userChannels: stateSlices.userChannels,
    };
  }

  async exec(prepRes: CycleNodePrepResult): Promise<CycleExecResult> {
    // Handle skip (resume case) - emit recovered todos before skipping
    if (prepRes.shouldSkip) {
      // Emit recovered todos to restore progress view UI after reload
      const recoveredTodos = prepRes.workspaceState.todos.todos;
      if (recoveredTodos.length > 0) {
        this.emitTodosUpdate(recoveredTodos);
      }
      return { kind: 'skipped' };
    }

    // Create cycle shared state (flat pattern like ResponseCycleFlow)
    // Tool-use cycles track metrics in shared (cycleIndex, etc.) instead of round object
    // cycleIndex starts from run.totalRounds to maintain continuity across user follow-ups
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

    // Create and run the flow directly (like ResponseCycleNode)
    // Spread parent services directly - no intermediate cycleOptions object
    const services = this.services;
    const flow = createToolUseCycleFlow<C>();
    const onRoundFinalized = services.getUsageRecorder();
    flow.setServices({
      ...services, // Parent ToolUseServices has most needed fields
      setting: { ...services.setting, tools: services.resolvedTools }, // Override with resolved tools
      client: await services.modelHandler.getClient(), // Get fresh client from handler
      run: prepRes.runState,
      workspace: prepRes.workspaceState,
      onRoundFinalized,
      // Model/agent identifiers for debug gating (isRemoteAgent check)
      modelName: services.config.model,
      agentName: services.config.agent,
    });

    // Set up todo update callback to emit changes to the progress view
    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      this.emitTodosUpdate(todos);
    });

    try {
      await flow.run(cycleShared);

      // Interpret cycle completion using shared helper
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
      // Return messages explicitly to ensure they're synced in post()
      // cycleShared.messages was mutated during the cycle flow
      return { kind: 'success', messages: cycleShared.messages };
    } catch (error) {
      return {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Clear the todo update callback to prevent memory leaks
      prepRes.workspaceState.todos.clearOnUpdate();
    }
  }

  async execFallback(
    _prepRes: CycleNodePrepResult,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'failed', message: error.message };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CycleNodePrepResult,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    // Clear skip flag for next iteration (side effect in post)
    if (prepRes.shouldSkip) {
      shared.state.shouldSkipCycle = false;
    }

    // Update state slices after cycle (cycle mutates run/workspace state)
    // This ensures workspace state changes (todos, interactions, etc.) are persisted
    shared.state.stateSlices = {
      runStateSnapshot: prepRes.runState.toSnapshot(),
      workspaceSnapshot: prepRes.workspaceState.toSnapshot(),
      userChannels: prepRes.userChannels,
    };

    switch (execRes.kind) {
      case 'success':
        // Explicitly sync conversation from cycle result to ensure messages are preserved
        // This is defensive - the array should be the same reference, but explicit sync
        // ensures PersistedFlow saves the correct state
        shared.state.conversation = execRes.messages;
        // PersistedFlow handles checkpoint persistence automatically after each node
        return FlowTransition.DEFAULT; // Follow next() → WaitNode

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
 * PocketFlow compliance:
 * - prep(): Check interruption state (no blocking I/O)
 * - exec(): Blocking I/O (enterWaitingState, waitForFollowUp)
 * - post(): Applies side effects (markRunning, update conversation)
 *
 * Session operations via this.services.session (not passed through prepRes).
 */
class ToolUseWaitNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  /**
   * Extract data needed for wait operation.
   * PocketFlow compliance: Extract data, no blocking I/O here.
   */
  async prep(_shared: ToolUseRunShared): Promise<WaitNodePrepResult> {
    const checkInterruption = this.services.checkInterruption;

    // Check interruption first - if interrupted, skip exec entirely
    if (checkInterruption()) {
      return { interrupted: true };
    }

    return { interrupted: false };
  }

  /**
   * Wait for follow-up message.
   *
   * PocketFlow compliance: Blocking I/O in exec() ensures errors are
   * caught by the retry loop and handled by execFallback().
   */
  async exec(prepRes: WaitNodePrepResult): Promise<WaitExecResult> {
    // Skip if already interrupted in prep
    if (prepRes.interrupted) {
      return { kind: 'stop', reason: 'interrupted' };
    }

    const session = this.services.session;
    const checkInterruption = this.services.checkInterruption;

    // Enter waiting state if no queued follow-up
    if (!session.hasQueuedFollowUp()) {
      await session.enterWaitingState();
    }

    // Wait for follow-up (blocking I/O - errors caught by execFallback)
    const followUp = await session.waitForFollowUp(checkInterruption);

    // Check interruption after wait
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

  /**
   * Apply follow-up to conversation.
   * PocketFlow compliance: All state mutations happen in post().
   */
  async post(
    shared: ToolUseRunShared,
    _prepRes: WaitNodePrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      // No follow-up or interrupted - flow ends gracefully
      return FlowTransition.DEFAULT;
    }

    // Notify that follow-up was consumed (updates queued message UI)
    this.services.onFollowUpConsumed?.();

    // Apply follow-up (state mutation in post - correct)
    const session = this.services.session;
    await session.markRunning();
    this.services.logger.userMessage(execRes.followUp);
    shared.state.conversation =
      await this.services.modelHandler.createUserFollowUpMessages(
        shared.state.conversation,
        execRes.followUp,
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

  // waitNode transitions:
  // - CONTINUE: Loop back to cycleNode for next interaction
  // - DEFAULT: Flow ends gracefully (no successor = intentional termination)
  //
  // Unlike ResponseCycleFlow which routes all exits through a finalize node,
  // ToolUseRunFlow ends immediately when there's no follow-up. This is
  // intentional because run-level finalization is handled by the agent's
  // finally block, not by a flow node.
  waitNode.on(FlowTransition.CONTINUE, cycleNode);

  return new Flow<ToolUseRunShared, ToolUseFlowParams, ToolUseServices<C>>(
    prepareNode,
  );
}
