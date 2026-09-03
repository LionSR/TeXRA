// Local imports - shared schemas
import { AgentCategory } from '@shared/schemas';

// Local constants - session types. SessionTypeSchema aliases
// AgentCategorySchema, so name the members directly — positional
// destructuring of `.options` would silently swap on enum-order changes.
export const SESSION_TYPES = {
  TOOL_USE: AgentCategory.ToolUse,
  WORKFLOW: AgentCategory.Workflow,
} as const;
