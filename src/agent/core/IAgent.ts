// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { EndGroupStatus } from '@logger/messageTypes';
import type { AgentSessionDescriptor } from './AgentDataclass';
import type { AgentConfig } from './AgentConfig';

/**
 * Minimal interface implemented by all agent types.
 */
export interface IAgent {
  /** Agent configuration used during execution. */
  readonly config: AgentConfig;

  /**
   * Initialize the agent before running.
   * @param parentGroupId - Optional parent group ID for nested logging
   * @param options - Initialization options
   * @param options.createStage - Whether to create a new log stage (default: true)
   */
  init(
    parentStage?: AgentLogStage,
    options?: { createStage?: boolean },
  ): Promise<void>;

  /** Execute the agent. */
  run(): Promise<void>;

  /** Interrupt the agent if it is running. */
  interrupt(): void;

  /**
   * Unique identifier used to route logs and progress updates for this agent run.
   */
  getStreamTabId(): StreamTabId;

  /**
   * Report how the agent identifies its session for logging and UI purposes.
   */
  getSessionMetadata(): AgentSessionDescriptor;

  /**
   * Return the most recent run group identifier for logging fallbacks.
   */
  getLastRunGroupId(): string | undefined;

  /** Retrieve the shared execution context for this agent. */
  getExecutionContext(): AgentExecutionContext;
}

/**
 * Minimal interface for agents used by flow nodes.
 *
 * This interface defines the minimal contract that flow implementations
 * depend on, enabling proper decoupling from concrete agent classes.
 * Specific flow types extend this with their required methods.
 *
 * Lifecycle methods (startRun, initRun, endRun, cleanupRun) are internalized
 * here rather than exposed as hooks, since they have identical implementations
 * across all agent types. Flow-specific hooks are defined separately by each
 * flow type (e.g., ToolUseRunHooks, ReflectionRunHooks).
 */
export interface IFlowAgent {
  /** Check if an interruption has been requested for this agent. */
  isInterruptionRequested(): boolean;

  // =========================================================================
  // Lifecycle Methods - Internalized (not hooks)
  // These have identical implementations across all agents.
  // =========================================================================

  /**
   * Begin and initialize an agent run.
   * Creates a logging stage (if needed) and performs agent initialization.
   * Combines the previously separate startRun() and initRun() since they
   * are always called together sequentially.
   */
  startAndInitRun(): Promise<void>;

  /** Initialize the model client for this run. */
  initializeClient(): Promise<void>;

  /**
   * End the agent run with the given status.
   * @param status - The completion status.
   */
  endRun(status: EndGroupStatus): void | Promise<void>;

  /** Clean up resources after the run completes. */
  cleanupRun(): void | Promise<void>;
}
