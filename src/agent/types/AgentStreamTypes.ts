// Local types - agent
import { AgentSessionKind } from '@agent/core/AgentDataclass';

/**
 * Allowed filter values for agent streams in the ProgressBoard.
 * "workflow" groups traditional direct/CoT agents while
 * "toolUse" isolates interactive tool sessions.
 */
export type AgentTypeFilter = 'all' | AgentSessionKind;

/**
 * Type guard ensuring a value is a valid {@link AgentTypeFilter}.
 */
export function isAgentTypeFilter(value: unknown): value is AgentTypeFilter {
  return (
    value === 'all' ||
    value === AgentSessionKind.Workflow ||
    value === AgentSessionKind.ToolUse
  );
}
