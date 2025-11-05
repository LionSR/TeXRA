// Local imports - agent
import type { AgentConfig } from './AgentConfig';
// Local imports - agent components
import type { AgentSessionDescriptor } from './AgentDataclass';
// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentLogStage } from '@logger/AgentLogger';

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

  /**
   * Retrieve the hooks used to orchestrate an agent run.
   *
   * @param overrides - Optional overrides for default hook implementations.
   */
  getRunHooks(overrides?: Partial<AgentRunHooks>): AgentRunHooks;
}

/**
 * Core hook contract used to orchestrate agent runs.
 */
export interface AgentRunHooks {
  /**
   * Begin an agent run and optionally create a logging group.
   *
   * @returns The identifier for the run group used by subsequent lifecycle hooks.
   *          Return `undefined` to indicate that the lifecycle should reuse an
   *          existing log group (for example, interactive tool-use sessions).
   */
  start(): Promise<AgentLogStage | undefined>;
  init(runStage: AgentLogStage | undefined): Promise<void>;
  initializeClient(): Promise<void>;
  end(status: 'stopped' | 'error'): void | Promise<void>;
  cleanup(): void | Promise<void>;
}
