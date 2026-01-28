import { z } from 'zod';

import {
  AgentCategory,
  AgentSettingSchema,
  AgentPromptSchema,
} from '@agent/core/AgentDataclass';

/** Remote agent list item from DB. Description is cached; YAML is source of truth. */
export const RemoteAgentListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  visibility: z.array(z.string()).nullish(),
  /** Defaults to Workflow for backward compatibility with existing DB rows. */
  agentCategory: z
    .enum(AgentCategory)
    .nullish()
    .transform((val) => val ?? AgentCategory.Workflow),
});

export type RemoteAgentListItem = z.infer<typeof RemoteAgentListItemSchema>;

/** Edge function response containing YAML config. */
export const EdgeFunctionResponseSchema = z.object({
  config: z.string().min(1, 'Server returned empty configuration'),
});

export type EdgeFunctionResponse = z.infer<typeof EdgeFunctionResponseSchema>;

/** Loaded remote agent configuration (settings + prompts). */
export const RemoteAgentConfigSchema = z.strictObject({
  settings: AgentSettingSchema,
  prompts: AgentPromptSchema,
});

export type RemoteAgentConfig = z.infer<typeof RemoteAgentConfigSchema>;
