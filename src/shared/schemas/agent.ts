import { z } from 'zod';

export const AGENT_CATEGORY = {
  WORKFLOW: 'workflow',
  TOOL_USE: 'toolUse',
} as const;

export const AgentCategorySchema = z.enum([
  AGENT_CATEGORY.WORKFLOW,
  AGENT_CATEGORY.TOOL_USE,
]);

export type AgentCategory = z.infer<typeof AgentCategorySchema>;

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  BUILT_IN_WORKFLOW: 'builtInWorkflow',
  BUILT_IN_TOOL_USE: 'builtInToolUse',
  REMOTE: 'remote',
} as const;

export const AgentSourceSchema = z.enum([
  AGENT_SOURCE.CUSTOM,
  AGENT_SOURCE.BUILT_IN_WORKFLOW,
  AGENT_SOURCE.BUILT_IN_TOOL_USE,
  AGENT_SOURCE.REMOTE,
]);

export type AgentSourceType = z.infer<typeof AgentSourceSchema>;
