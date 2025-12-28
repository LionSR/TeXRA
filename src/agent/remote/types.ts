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

// Re-export LoadAgentOptions as RemoteAgentLoadOptions for API consistency
export type { LoadAgentOptions as RemoteAgentLoadOptions } from '@agent/runtime/agentLoad';

/**
 * Schema for remote agent metadata.
 * Uses .nullish() to accept null from database and normalize to undefined.
 */
export const RemoteAgentMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Description can be NULL in the database */
  description: z.string().nullish(),
  /** Visibility can be NULL in the database */
  visibility: z.array(z.string()).nullish(),
  /** Agent category: 'workflow' or 'toolUse' */
  agentCategory: z.enum(AgentCategory).nullish(),
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
