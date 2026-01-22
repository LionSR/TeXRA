// Local types - agent
import { AgentCategory } from '@agent/core/AgentDataclass';

/**
 * Allowed filter values for agent streams in the ProgressBoard.
 * "workflow" groups traditional workflow agents while
 * "toolUse" isolates interactive tool sessions.
 */
export type AgentCategoryFilter = 'all' | AgentCategory;

/**
 * Type guard ensuring a value is a valid {@link AgentCategoryFilter}.
 */
export function isAgentCategoryFilter(
  value: unknown,
): value is AgentCategoryFilter {
  return (
    value === 'all' ||
    value === AgentCategory.Workflow ||
    value === AgentCategory.ToolUse
  );
}
