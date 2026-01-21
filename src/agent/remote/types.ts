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

// Re-export AgentLoadOptions as RemoteAgentLoadOptions for API consistency
export type { AgentLoadOptions as RemoteAgentLoadOptions } from '@agent/runtime/agentLoad';

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
  /** Agent category: 'workflow' or 'toolUse' */
  agentCategory: z.nativeEnum(AgentCategory).optional(),
});

export type RemoteAgentListItem = z.infer<typeof RemoteAgentListItemSchema>;

/**
 * Full remote agent metadata. Same shape as list item.
 * When loaded via loadRemoteAgent(), description comes from YAML.
 */
export const RemoteAgentMetadataSchema = RemoteAgentListItemSchema;

export type RemoteAgentMetadata = z.infer<typeof RemoteAgentMetadataSchema>;

/**
 * Schema for configuration loaded from a remote agent source.
 * Composed from existing schemas - single source of truth.
 */
export const RemoteAgentConfigSchema = z.strictObject({
  name: z.string(),
  settings: AgentSettingSchema,
  prompts: AgentPromptSchema,
  metadata: RemoteAgentMetadataSchema,
});

/** Derived from RemoteAgentConfigSchema - single source of truth */
export type RemoteAgentConfig = z.infer<typeof RemoteAgentConfigSchema>;
