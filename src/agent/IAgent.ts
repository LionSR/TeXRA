// Local imports - agent components
import { AgentConfig } from './AgentConfig';

/**
 * Minimal interface implemented by all agent types.
 */
export interface IAgent {
  /** Agent configuration used during execution. */
  readonly config: AgentConfig;

  /** Initialize the agent before running. */
  init(parentGroupId?: string): Promise<void>;

  /** Execute the agent. */
  run(): Promise<void>;

  /** Interrupt the agent if it is running. */
  interrupt(): void;
}
