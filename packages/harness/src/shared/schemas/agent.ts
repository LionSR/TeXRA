import { z } from 'zod';

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  /** Shipped with TeXRA: the bundled agent directories and those of the
   *  first-party plugins that are on. */
  BUILT_IN: 'builtIn',
  /** An installed Claude Code or Codex plugin's agent, named `<plugin>:<name>`. */
  PLUGIN: 'plugin',
} as const;

/** Single source of truth for agent source identifiers. */
export const AgentSourceSchema = z.enum(AGENT_SOURCE);

export type AgentSource = z.infer<typeof AgentSourceSchema>;

/**
 * True for the sources whose definitions are read in place and are not the
 * user's to edit: the bundled one, and an installed
 * plugin's. Every surface that offers to open one presents it read-only and
 * points edits at the custom copy; the extension additionally registers the
 * bundled directories `writable: false` for its file tools.
 */
export function isPackagedAgentSource(source: AgentSource): boolean {
  return source === AGENT_SOURCE.BUILT_IN || source === AGENT_SOURCE.PLUGIN;
}

const AGENT_NAME_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(AGENT_NAME_IDENTIFIER, {
    message:
      'Agent names must be identifiers: letters, numbers, underscores, or hyphens.',
  });

/** An agent's name as the catalog lists it: its own, or `<plugin>:<name>`
 *  for an installed plugin's agent. A definition names itself bare. */
const CatalogAgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?:[a-z0-9][a-z0-9-]*:)?[A-Za-z0-9][A-Za-z0-9_-]*$/u, {
    message:
      'Agent names must be identifiers (letters, numbers, underscores, or hyphens), optionally after a plugin name and a colon.',
  });

/**
 * Base schema for agent identity metadata shared across all agent representations.
 * View-specific schemas (AgentSelectionItemSchema, etc.)
 * should extend this via `.extend()` rather than redefining these fields.
 */
export const AgentMetadataBaseSchema = z.object({
  name: CatalogAgentNameSchema,
  /** Its file has a `task` block: it is also launchable as a document task. */
  hasTask: z.boolean(),
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

/**
 * The agent name in an identifier: a source-qualified key's name
 * ("plugin:paper:review" → "paper:review", "custom:x" → "x"), or the
 * identifier itself when it names no source ("paper:review", or a URL).
 */
export function agentName(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 && AgentSourceSchema.safeParse(key.slice(0, idx)).success
    ? key.slice(idx + 1)
    : key;
}

/**
 * The agent name in an identifier as one file-name segment: a plugin
 * agent's `<plugin>:<name>` becomes `<plugin>__<name>`, since `:` is not a
 * file-name character on every platform. Run packs, run directories and
 * copy stems derive their names through this alone.
 */
export function agentFileName(key: string): string {
  return agentName(key).replaceAll(':', '__');
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

/** A custom-agent YAML file the registry found but could not load. */
export const AgentScanIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type AgentScanIssue = z.infer<typeof AgentScanIssueSchema>;
