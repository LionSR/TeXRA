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

/**
 * Single source of truth for agent source identifiers.
 * Backend re-exports this from @agent/core/AgentDataclass as `AgentSource`.
 */
export const AgentSourceSchema = z.enum([
  AGENT_SOURCE.CUSTOM,
  AGENT_SOURCE.BUILT_IN_WORKFLOW,
  AGENT_SOURCE.BUILT_IN_TOOL_USE,
  AGENT_SOURCE.REMOTE,
]);

export type AgentSourceType = z.infer<typeof AgentSourceSchema>;

// Backend-compatible alias: value + type share the name "AgentSource"
// (the standard Zod dual-export pattern used throughout the backend)
export const AgentSource = AgentSourceSchema;
export type AgentSource = AgentSourceType;

/**
 * Base schema for agent identity metadata shared across all agent representations.
 * View-specific schemas (RemoteAgentSchema, AgentSelectionItemSchema, etc.)
 * should extend this via `.extend()` rather than redefining these fields.
 */
export const AgentMetadataBaseSchema = z.object({
  name: z.string(),
  category: AgentCategorySchema,
  description: z.string().optional(),
});

export type AgentMetadataBase = z.infer<typeof AgentMetadataBaseSchema>;

/** Canonical key format: disambiguates agents with same name across sources. */
export function agentKey(source: string, name: string): string {
  return `${source}:${name}`;
}

/** Extract the plain agent name from a possibly source-qualified key ("source:name" → "name"). */
export function agentName(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}
