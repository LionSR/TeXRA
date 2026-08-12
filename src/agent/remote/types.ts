import { z } from 'zod';

import {
  type AgentPrompt,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { AgentNameSchema, AgentCategory } from '@shared/schemas/agent';

/**
 * Remote agent list item from DB. Description is cached; YAML is source of truth.
 *
 * Note: Uses `agentCategory` (DB column name) instead of canonical `category`
 * from AgentMetadataBaseSchema. See also: AgentMetadataBaseSchema in
 * @shared/schemas/agent for the canonical fields.
 */
export const RemoteAgentListItemSchema = z.object({
  id: z.string(),
  name: AgentNameSchema,
  description: z.string().nullish(),
  visibility: z.array(z.string()).nullish(),
  /** Cached tool names from YAML. Available when DB column is populated. */
  tools: z.array(z.string()).nullish(),
  agentCategory: z.enum(AgentCategory),
});

export type RemoteAgentListItem = z.infer<typeof RemoteAgentListItemSchema>;

/** Edge function response containing YAML config. */
export const EdgeFunctionResponseSchema = z.object({
  config: z.string().min(1, 'Server returned empty configuration'),
});

/**
 * Loaded remote agent configuration (settings + prompts).
 *
 * Plain interface, not a zod schema: the loader already validates `settings`
 * and `prompts` through their own schemas (AgentSettingSchema / AgentPromptSchema)
 * before building this object, so a combined schema here would only assert a
 * strict shape nothing ever parses against.
 */
export interface RemoteAgentConfig {
  settings: AgentSetting;
  prompts: AgentPrompt;
}
