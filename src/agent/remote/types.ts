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
 * Does NOT include description - that comes from YAML when agent is loaded.
 */
export const RemoteAgentListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Visibility can be NULL in the database */
  visibility: z.array(z.string()).nullish(),
  /** Agent category: 'workflow' or 'toolUse' */
  agentCategory: z.enum(AgentCategory).nullish(),
});

export type RemoteAgentListItem = z.infer<typeof RemoteAgentListItemSchema>;

/**
 * Schema for full remote agent metadata (after loading YAML).
 * Extends list item with description from YAML.
 */
export const RemoteAgentMetadataSchema = RemoteAgentListItemSchema.extend({
  /** Description from YAML (not stored in DB) */
  description: z.string().nullish(),
});

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
