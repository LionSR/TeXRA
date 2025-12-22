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
 * Helper to transform null to undefined for optional fields.
 * Database returns null, but codebase uses undefined for optional values.
 */
const nullToUndefined = <T>(val: T | null): T | undefined =>
  val === null ? undefined : val;

/**
 * Schema for remote agent metadata.
 * Accepts null from database but transforms to undefined for codebase compatibility.
 */
export const RemoteAgentMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Description can be NULL in the database, transformed to undefined */
  description: z.string().nullable().transform(nullToUndefined),
  /** Visibility can be NULL in the database, transformed to undefined */
  visibility: z.array(z.string()).nullable().transform(nullToUndefined),
  /** Agent category: 'workflow' or 'toolUse' */
  agentCategory: z
    .nativeEnum(AgentCategory)
    .nullable()
    .transform(nullToUndefined),
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
