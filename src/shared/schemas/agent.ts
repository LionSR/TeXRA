import { z } from 'zod';

/**
 * Workflow: fixed-round document processing. ToolUse: interactive tool-calling.
 *
 * Exported as a const object (not a TS enum) so it can be imported from
 * `@shared/*` zones (which forbid `vscode`-flavored TS-only constructs) and
 * still supports enum-style member access (`AgentCategory.Workflow`).
 */
export const AgentCategory = {
  Workflow: 'workflow',
  ToolUse: 'toolUse',
} as const;
export type AgentCategory = (typeof AgentCategory)[keyof typeof AgentCategory];

/**
 * Legacy alias preserving UPPER_SNAKE keys for call sites that already use it
 * (e.g. `AGENT_CATEGORY.WORKFLOW`). Prefer `AgentCategory.Workflow` in new code.
 */
export const AGENT_CATEGORY = {
  WORKFLOW: AgentCategory.Workflow,
  TOOL_USE: AgentCategory.ToolUse,
} as const;

export const AgentCategorySchema = z.enum([
  AgentCategory.Workflow,
  AgentCategory.ToolUse,
]);

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  BUILT_IN_WORKFLOW: 'builtInWorkflow',
  BUILT_IN_TOOL_USE: 'builtInToolUse',
  REMOTE: 'remote',
} as const;

/** Single source of truth for agent source identifiers. */
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
