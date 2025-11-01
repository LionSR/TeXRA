// Local imports - agent components
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Shared execution context for a single agent run.
 *
 * Encapsulates identifiers and logging state so that every component
 * participating in the run (agent, model handler, utilities) can rely on the
 * same identifiers and logger instance.
 */
export interface AgentRunContext {
  /** Fully-qualified stream tab identifier used for routing logs and updates. */
  readonly streamTabId: StreamTabId;
  /** Optional execution identifier used for persisted runs. */
  readonly executionId?: ExecutionId;
  /** Human-readable agent name for diagnostics. */
  readonly agentName: string;
  /** Model identifier configured for the run. */
  readonly model: string;
  /** Session classification metadata. */
  readonly session: AgentSessionDescriptor;
  /** Primary logger scoped to the stream tab. */
  readonly logger: AgentLogger;
}
