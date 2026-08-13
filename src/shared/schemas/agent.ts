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

/** Every agent category, in canonical display order. */
export const AGENT_CATEGORIES = [
  AgentCategory.Workflow,
  AgentCategory.ToolUse,
] as const;

/**
 * One value per agent category. The single generic shape for every
 * category-partitioned fact (rosters, selections, catalogs, form state) —
 * replaces the historical `workflow*`/`toolUse*` field pairs.
 */
export type ByCategory<T> = Record<AgentCategory, T>;

/** Build a {@link ByCategory} record by evaluating `build` per category. */
export function byCategory<T>(
  build: (category: AgentCategory) => T,
): ByCategory<T> {
  return {
    [AgentCategory.Workflow]: build(AgentCategory.Workflow),
    [AgentCategory.ToolUse]: build(AgentCategory.ToolUse),
  };
}

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  BUILT_IN_WORKFLOW: 'builtInWorkflow',
  BUILT_IN_TOOL_USE: 'builtInToolUse',
  REMOTE: 'remote',
  /**
   * Definition supplied as a value rather than read from a YAML file — the
   * embedding-API counterpart of `remote`, which likewise fabricates a registry
   * entry with an empty `path` and skips the loader's filesystem read. Entries
   * come from `registerInlineAgents` (`@agent/index/agentRegistry`).
   */
  INLINE: 'inline',
} as const;

/** Single source of truth for agent source identifiers. */
export const AgentSourceSchema = z.enum(AGENT_SOURCE);

export type AgentSource = z.infer<typeof AgentSourceSchema>;

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
