// Third-party imports
import { z } from 'zod';

/**
 * Agent category values - single source of truth.
 *
 * **Workflow**: Document processing agents that run for a fixed number of rounds.
 * **ToolUse**: Interactive agents with tool-calling capabilities.
 */
export const AGENT_CATEGORY_VALUES = ['workflow', 'toolUse'] as const;

/**
 * Zod schema for agent category validation.
 * Use this in Zod schemas: `agentCategory: AgentCategorySchema`
 */
export const AgentCategorySchema = z.enum(AGENT_CATEGORY_VALUES);

/**
 * TypeScript type for agent category.
 * Derived from schema: 'workflow' | 'toolUse'
 */
export type AgentCategory = z.infer<typeof AgentCategorySchema>;

/**
 * Named constants for code that uses `AgentCategory.Workflow` syntax.
 * Maintains backward compatibility with existing TypeScript enum usage.
 *
 * @example
 * if (setting.agentCategory === AgentCategory.Workflow) { ... }
 */
export const AgentCategory = {
  Workflow: 'workflow',
  ToolUse: 'toolUse',
} as const satisfies Record<string, AgentCategory>;

/**
 * Legacy constant format for JavaScript webview code.
 * Use `AgentCategory` for new TypeScript code.
 *
 * @deprecated Use `AgentCategory` instead
 */
export const AGENT_CATEGORY = {
  WORKFLOW: 'workflow',
  TOOL_USE: 'toolUse',
} as const satisfies Record<string, AgentCategory>;
