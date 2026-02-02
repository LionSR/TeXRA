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
