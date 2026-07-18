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

export const AgentCategorySchema = z.enum(AgentCategory);

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  BUILT_IN_WORKFLOW: 'builtInWorkflow',
  BUILT_IN_TOOL_USE: 'builtInToolUse',
  REMOTE: 'remote',
} as const;

/** Single source of truth for agent source identifiers. */
export const AgentSourceSchema = z.enum(AGENT_SOURCE);

export type AgentSourceType = z.infer<typeof AgentSourceSchema>;

// Backend-compatible type alias under the plain name "AgentSource". The
// former value half of the Zod dual-export pattern (`const AgentSource =
// AgentSourceSchema`) was dropped once every consumer proved type-only;
// value use sites import `AgentSourceSchema` directly.
export type AgentSource = AgentSourceType;

const AGENT_NAME_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(AGENT_NAME_IDENTIFIER, {
    message:
      'Agent names must be identifiers: letters, numbers, underscores, or hyphens.',
  });

/**
 * Base schema for agent identity metadata shared across all agent representations.
 * View-specific schemas (RemoteAgentSchema, AgentSelectionItemSchema, etc.)
 * should extend this via `.extend()` rather than redefining these fields.
 */
export const AgentMetadataBaseSchema = z.object({
  name: AgentNameSchema,
  category: AgentCategorySchema,
  description: z.string().optional(),
});

/** Canonical key format: disambiguates agents with same name across sources. */
export function agentKey(source: string, name: string): string {
  return `${source}:${name}`;
}

/**
 * Canonical key for an agent-like record. Single source for the "entry → key"
 * mapping so the dozen-plus call sites don't each spell out
 * `agentKey(x.source, x.name)`.
 */
export function agentKeyOf(entry: { source: string; name: string }): string {
  return agentKey(entry.source, entry.name);
}

/** Extract the plain agent name from a possibly source-qualified key ("source:name" → "name"). */
export function agentName(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/** Match bare names by name and source-qualified keys by exact identity. */
export function agentMatchesIdentifier(
  entry: { source: string; name: string },
  identifier: string,
): boolean {
  const name = agentName(identifier);
  return identifier === name
    ? entry.name === name
    : agentKeyOf(entry) === identifier;
}

/**
 * Extract the clean agent name from an identifier.
 * Like agentName() but validates the prefix is a known AgentSource first,
 * so arbitrary strings with colons (e.g. URLs) pass through unchanged.
 */
export function getCleanAgentName(agentIdentifier: string): string {
  const colonIdx = agentIdentifier.indexOf(':');
  if (colonIdx === -1) return agentIdentifier;

  const source = agentIdentifier.slice(0, colonIdx);
  if (!AgentSourceSchema.safeParse(source).success) return agentIdentifier;

  return agentName(agentIdentifier);
}
