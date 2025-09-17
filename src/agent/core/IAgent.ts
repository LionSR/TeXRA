// Local imports - agent
// Local imports - agent components
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
}
