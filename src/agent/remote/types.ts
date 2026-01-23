/**
 * Core types for remote agent configuration.
 *
 * Uses Zod schemas as single source of truth per project guidelines.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - agent core
import {
  AgentCategory,
  AgentSettingSchema,
  AgentPromptSchema,
} from '@agent/core/AgentDataclass';

/**
 * Schema for remote agent list items (from DB queries).
 * Description from DB serves as cache; authoritative value comes from YAML when loaded.
 */
export const RemoteAgentListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Cached description from DB (YAML is source of truth) */
  description: z.string().nullish(),
  /** Visibility can be NULL in the database */
  visibility: z.array(z.string()).nullish(),
  /**
   * Agent category: 'workflow' or 'toolUse'.
   * Defaults NULL to Workflow for backward compatibility with existing DB rows.
   */
  agentCategory: z
    .nativeEnum(AgentCategory)
    .nullish()
    .transform((val) => val ?? AgentCategory.Workflow),
});

export type RemoteAgentListItem = z.infer<typeof RemoteAgentListItemSchema>;

/**
 * Schema for edge function response when loading a remote agent.
 * Validates the JSON response before processing.
 */
export const EdgeFunctionResponseSchema = z.object({
  /** YAML content of the agent definition */
  config: z.string().min(1, 'Server returned empty configuration'),
});

export type EdgeFunctionResponse = z.infer<typeof EdgeFunctionResponseSchema>;

/**
 * Schema for configuration loaded from a remote agent source.
 * Contains only what's actually consumed by callers (settings + prompts).
 */
export const RemoteAgentConfigSchema = z.strictObject({
  settings: AgentSettingSchema,
  prompts: AgentPromptSchema,
});

/** Derived from RemoteAgentConfigSchema - single source of truth */
export type RemoteAgentConfig = z.infer<typeof RemoteAgentConfigSchema>;
