// Local imports - agent
import type { AgentConfig } from './AgentConfig';
// Local imports - agent components
import type { AgentSessionMetadata } from './AgentDataclass';
// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';

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
   * @param options.createGroup - Whether to create a new log group (default: true)
   */
  init(
    parentGroupId?: string,
    options?: { createGroup?: boolean },
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
  getSessionMetadata(): AgentSessionMetadata;

  /**
   * Return the most recent run group identifier for logging fallbacks.
   */
  getLastRunGroupId(): string | undefined;
}
